"""
ComfyUI-WorkflowOrganizer
Adds drag-and-drop support to the Workflows sidebar.
"""

from server import PromptServer
from aiohttp import web
import asyncio
import folder_paths
import json
import os
import re
import shutil
import time
import uuid

WEB_DIRECTORY = "./js"

TRASH_DIRNAME = ".wfo_trash"
TRASH_MAX_AGE_DAYS = 7


def _trash_dir(base):
    """Hidden trash directory beside the workflows folder (never in the tree)."""
    return os.path.join(base, TRASH_DIRNAME)


def _trash_token(name):
    """Build a trash token: "<deleted_at_ms>_<uuid8>_<original name>".

    The uuid segment prevents collisions when two same-named items are trashed
    within the same millisecond (easily happens during a bulk delete) — a
    colliding token would otherwise make shutil.move overwrite/nest the first
    entry. _prune_trash only reads the leading "<ms>_" segment, so this is
    backward compatible with existing trash entries.
    """
    return "%d_%s_%s" % (int(time.time() * 1000), uuid.uuid4().hex[:8], name)


def _prune_trash(trash):
    """Remove trash entries older than TRASH_MAX_AGE_DAYS.

    Age is derived from the deletion timestamp encoded in the token itself
    (the token's leading "<ms>_" prefix set when it was trashed), never from
    the entry's mtime — mtime is inherited from the last content edit (shutil.move
    preserves it), so a folder last touched weeks ago but only just deleted
    would otherwise be purged within seconds of landing in the trash.
    """
    if not os.path.isdir(trash):
        return
    cutoff = time.time() - TRASH_MAX_AGE_DAYS * 86400
    for name in os.listdir(trash):
        p = os.path.join(trash, name)
        try:
            deleted_at = int(name.split("_", 1)[0]) / 1000
        except (ValueError, IndexError):
            continue  # token doesn't parse; leave it alone rather than guess
        if deleted_at < cutoff:
            try:
                if os.path.isfile(p):
                    os.remove(p)
                else:
                    shutil.rmtree(p, ignore_errors=True)
            except Exception:
                pass


def _user_root():
    """Path to ComfyUI's user directory (handles older/newer versions)."""
    try:
        return folder_paths.get_user_directory()
    except Exception:
        return os.path.join(folder_paths.base_path, "user")


def _get_user_base(request=None):
    """Return the directory of the user making the request.

    Multi-user aware: when a request is given, ask ComfyUI's own UserManager
    which user it belongs to (the same mechanism the native userdata endpoints
    use), and only ever operate on that user's directory — a failure to resolve
    it is fatal (returns None -> 404), never a silent fallback to some other
    user's folder. The scan-for-first-user fallback is reserved for internal
    callers with no request (there is no "wrong user" to protect against then).
    """
    user_root = _user_root()

    if request is not None:
        try:
            user_id = PromptServer.instance.user_manager.get_request_user_id(request)
        except Exception:
            return None
        if not user_id:
            return None
        cand = os.path.join(user_root, user_id)
        if not os.path.isdir(cand):
            return None
        return cand

    if not os.path.isdir(user_root):
        return None
    for uid in os.listdir(user_root):
        uid_path = os.path.join(user_root, uid)
        if os.path.isdir(os.path.join(uid_path, "workflows")):
            return uid_path
    return None


def _resolve_safe(base, rel):
    """Resolve rel under base; return None if it escapes base."""
    candidate = os.path.realpath(os.path.join(base, rel))
    if os.path.normcase(candidate).startswith(os.path.normcase(os.path.realpath(base) + os.sep)):
        return candidate
    return None


# ── Per-folder metadata (colors), stored beside the workflows dir ────────────
def _meta_file(base):
    return os.path.join(base, ".wfo_meta.json")


def _load_meta(base):
    f = _meta_file(base)
    if os.path.isfile(f):
        try:
            with open(f, encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            return {}
    return {}


# Guards every .wfo_meta.json read-modify-write sequence. _save_meta's atomic
# rename makes a single write safe, but without this two concurrent requests
# (e.g. two browser tabs coloring different folders at once) can both read the
# same "before" state and the second write silently discards the first's
# change. Single aiohttp process/event loop, so one lock is enough.
_meta_lock = asyncio.Lock()


def _save_meta(base, data):
    """Write .wfo_meta.json atomically: write to a temp file, then rename over
    the real file. os.replace is atomic on both Windows and POSIX, so a crash
    or power loss mid-write can never leave a corrupted/truncated meta file
    (the old file stays intact until the new one is fully written)."""
    target = _meta_file(base)
    tmp = target + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        os.replace(tmp, target)
    except Exception:
        try:
            os.remove(tmp)
        except Exception:
            pass


def _in_workflows(rel):
    """True if rel is "workflows" or starts with "workflows/".

    All filesystem-touching endpoints are anchored at the user's root dir
    (not the workflows dir) so that _resolve_safe's realpath check still
    catches "..", but that means a path like "comfy.settings.json" or
    ".wfo_meta.json" would otherwise resolve just fine too. This confines
    every such endpoint to the workflows subtree the client actually means.
    """
    return rel == "workflows" or rel.startswith("workflows/")


def _require_json_content_type(request):
    """Reject requests whose Content-Type isn't application/json.

    aiohttp's request.json() parses the body regardless of Content-Type, so
    without this a cross-origin page can POST a "simple request" (no CORS
    preflight, no Origin check) straight at these mutating endpoints. Requiring
    application/json forces the browser to preflight, which blocks the
    cross-origin call before it ever reaches us.
    """
    ctype = request.headers.get("Content-Type", "")
    return ctype.split(";")[0].strip().lower() == "application/json"


HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def _valid_color(color):
    return bool(HEX_COLOR_RE.match(color))


# Sanity caps on the color maps: hex values are already validated, but nothing
# capped key length or the total entry count, so a looping/misbehaving client
# could grow .wfo_meta.json unboundedly.
MAX_COLOR_KEY_LEN = 500
MAX_COLOR_ENTRIES = 5000


def _valid_color_key(key):
    return bool(key) and len(key) <= MAX_COLOR_KEY_LEN


# Windows-reserved device names (case-insensitive) that can't be used as a
# file/folder name, even with an extension (e.g. "CON.json" is also invalid).
_WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def _valid_name(name):
    """Reject names that are invalid on Windows (and generally unsafe):
    reserved device names, forbidden characters, and trailing dot/space
    (Windows silently strips these, which can cause confusing mismatches)."""
    if not name or name in (".", ".."):
        return False
    if any(ch in name for ch in '<>:"/\\|?*'):
        return False
    if name[-1] in (" ", "."):
        return False
    stem = name.split(".")[0].upper()
    if stem in _WINDOWS_RESERVED_NAMES:
        return False
    return True


def _remap_color_keys(base, old_rel, new_rel):
    """When a folder is renamed/moved, move its color (and any subfolders')."""
    old_rel = old_rel.replace("\\", "/").strip("/")
    new_rel = new_rel.replace("\\", "/").strip("/")
    # keys are relative to the workflows dir
    prefix = "workflows/"
    if old_rel.startswith(prefix):
        old_rel = old_rel[len(prefix):]
    if new_rel.startswith(prefix):
        new_rel = new_rel[len(prefix):]
    meta = _load_meta(base)
    changed = False

    # Folder colors: the folder itself plus any nested subfolders.
    colors = meta.get("colors", {})
    for key in list(colors.keys()):
        if key == old_rel:
            colors[new_rel] = colors.pop(key)
            changed = True
        elif key.startswith(old_rel + "/"):
            colors[new_rel + key[len(old_rel):]] = colors.pop(key)
            changed = True

    # File colors of every workflow that lived inside the moved/renamed folder.
    file_colors = meta.get("file_colors", {})
    for key in list(file_colors.keys()):
        if key.startswith(old_rel + "/"):
            file_colors[new_rel + key[len(old_rel):]] = file_colors.pop(key)
            changed = True

    if changed:
        meta["colors"] = colors
        meta["file_colors"] = file_colors
        _save_meta(base, meta)


def _remap_file_color_key(base, old_rel, new_rel):
    """When a workflow file is renamed, move its color to the new key."""
    prefix = "workflows/"
    def norm(r):
        r = r.replace("\\", "/").strip("/")
        if r.startswith(prefix):
            r = r[len(prefix):]
        if r.endswith(".json"):
            r = r[:-len(".json")]
        return r
    old_key = norm(old_rel)
    new_key = norm(new_rel)
    meta = _load_meta(base)
    file_colors = meta.get("file_colors", {})
    if old_key in file_colors:
        file_colors[new_key] = file_colors.pop(old_key)
        meta["file_colors"] = file_colors
        _save_meta(base, meta)


def _color_key_from_rel(rel):
    """Normalize a "workflows/..."-style rel path into a meta color key.

    Returns (key, is_file). Mirrors the stripping _remap_file_color_key does,
    so trash/restore key handling stays consistent with rename/move.
    """
    r = rel.replace("\\", "/").strip("/")
    prefix = "workflows/"
    if r.startswith(prefix):
        r = r[len(prefix):]
    is_file = r.endswith(".json")
    if is_file:
        r = r[:-len(".json")]
    return r, is_file


def _pop_colors_for_key(base, key, is_file):
    """Remove color entries for a file/folder (and, for folders, everything
    nested under it) that's about to be trashed, so a *new* item later created
    with the same name doesn't silently inherit the old color. Returns the
    popped entries (for restore) or None if there was nothing to remove.
    """
    meta = _load_meta(base)
    colors = meta.get("colors", {})
    file_colors = meta.get("file_colors", {})
    popped_colors, popped_file_colors = {}, {}
    changed = False

    if is_file:
        if key in file_colors:
            popped_file_colors[key] = file_colors.pop(key)
            changed = True
    else:
        for k in list(colors.keys()):
            if k == key or k.startswith(key + "/"):
                popped_colors[k] = colors.pop(k)
                changed = True
        for k in list(file_colors.keys()):
            if k.startswith(key + "/"):
                popped_file_colors[k] = file_colors.pop(k)
                changed = True

    if not changed:
        return None
    meta["colors"] = colors
    meta["file_colors"] = file_colors
    _save_meta(base, meta)
    return {"key": key, "is_file": is_file, "colors": popped_colors, "file_colors": popped_file_colors}


def _restore_colors(base, popped, new_key):
    """Re-apply colors popped by _pop_colors_for_key, remapped from the old
    key to new_key (the restore destination may differ from where it was
    trashed from, same as a rename)."""
    old_key = popped["key"]
    meta = _load_meta(base)
    colors = meta.get("colors", {})
    file_colors = meta.get("file_colors", {})
    for k, v in popped["colors"].items():
        colors[new_key + k[len(old_key):]] = v
    for k, v in popped["file_colors"].items():
        if popped["is_file"]:
            file_colors[new_key] = v
        else:
            file_colors[new_key + k[len(old_key):]] = v
    meta["colors"] = colors
    meta["file_colors"] = file_colors
    _save_meta(base, meta)


def _trash_colors_sidecar(trash, token):
    return os.path.join(trash, token + ".colors.json")


@PromptServer.instance.routes.post("/wfo/folder")
async def create_wfo_folder(request):
    try:
        if not _require_json_content_type(request):
            return web.Response(status=400, text="Content-Type must be application/json")
        data = await request.json()
        rel = data.get("path", "").replace("\\", "/").strip("/")
        if not rel or ".." in rel.split("/") or not _in_workflows(rel):
            return web.Response(status=400, text="Invalid path")
        # Validate every segment, not just the last — "workflows/CON/NewFolder"
        # would otherwise sail through and os.makedirs would try to create a
        # real "CON" directory, which Windows rejects with a raw OSError.
        if not all(_valid_name(seg) for seg in rel.split("/")[1:]):
            return web.Response(status=400, text="Invalid folder name")

        base = _get_user_base(request)
        if not base:
            return web.Response(status=404, text="Workflows directory not found")

        target = _resolve_safe(base, rel)
        if not target:
            return web.Response(status=403, text="Forbidden")

        os.makedirs(target, exist_ok=True)
        placeholder = os.path.join(target, "placeholder.json")
        if not os.path.exists(placeholder):
            with open(placeholder, "w", encoding="utf-8") as f:
                json.dump({"wfo_placeholder": True}, f)

        return web.Response(status=200)
    except Exception as e:
        return web.Response(status=500, text=str(e))


@PromptServer.instance.routes.delete("/wfo/folder")
async def delete_wfo_folder(request):
    try:
        if not _require_json_content_type(request):
            return web.Response(status=400, text="Content-Type must be application/json")
        data = await request.json()
        rel = data.get("path", "").replace("\\", "/").strip("/")
        if not rel or ".." in rel.split("/") or not _in_workflows(rel):
            return web.Response(status=400, text="Invalid path")

        base = _get_user_base(request)
        if not base:
            return web.Response(status=404, text="Workflows directory not found")

        target = _resolve_safe(base, rel)
        if not target or not os.path.isdir(target):
            return web.Response(status=404, text="Folder not found")

        # Move to a hidden trash dir instead of deleting, so it can be undone.
        # (The client always deletes recursively; there is no non-recursive caller.)
        trash = _trash_dir(base)
        os.makedirs(trash, exist_ok=True)
        _prune_trash(trash)
        token = _trash_token(os.path.basename(target))
        key, is_file = _color_key_from_rel(rel)
        async with _meta_lock:
            popped = _pop_colors_for_key(base, key, is_file)
        shutil.move(target, os.path.join(trash, token))
        if popped:
            with open(_trash_colors_sidecar(trash, token), "w", encoding="utf-8") as f:
                json.dump(popped, f)
        return web.json_response({"trash": token})
    except Exception as e:
        return web.Response(status=500, text=str(e))


@PromptServer.instance.routes.post("/wfo/trash")
async def trash_path(request):
    """Move a file or folder to the hidden trash; return its trash token.
    Works for single workflows (used by bulk delete) and folders alike."""
    try:
        if not _require_json_content_type(request):
            return web.Response(status=400, text="Content-Type must be application/json")
        data = await request.json()
        rel = data.get("path", "").replace("\\", "/").strip("/")
        if not rel or ".." in rel.split("/") or not _in_workflows(rel):
            return web.Response(status=400, text="Invalid path")

        base = _get_user_base(request)
        if not base:
            return web.Response(status=404, text="Workflows directory not found")

        target = _resolve_safe(base, rel)
        if not target or not os.path.exists(target):
            return web.Response(status=404, text="Not found")

        trash = _trash_dir(base)
        os.makedirs(trash, exist_ok=True)
        _prune_trash(trash)
        token = _trash_token(os.path.basename(target))
        key, is_file = _color_key_from_rel(rel)
        async with _meta_lock:
            popped = _pop_colors_for_key(base, key, is_file)
        shutil.move(target, os.path.join(trash, token))
        if popped:
            with open(_trash_colors_sidecar(trash, token), "w", encoding="utf-8") as f:
                json.dump(popped, f)
        return web.json_response({"trash": token})
    except Exception as e:
        return web.Response(status=500, text=str(e))


@PromptServer.instance.routes.post("/wfo/trash/restore")
async def restore_trash(request):
    """Move a trashed file or folder back to its original location (undo delete)."""
    try:
        if not _require_json_content_type(request):
            return web.Response(status=400, text="Content-Type must be application/json")
        data = await request.json()
        token = data.get("trash", "")
        dest_rel = data.get("dest", "").replace("\\", "/").strip("/")
        # token must be a single path segment (no traversal)
        if not token or "/" in token or "\\" in token or ".." in token:
            return web.Response(status=400, text="Invalid trash token")
        if not dest_rel or ".." in dest_rel.split("/") or not _in_workflows(dest_rel):
            return web.Response(status=400, text="Invalid path")

        base = _get_user_base(request)
        if not base:
            return web.Response(status=404, text="Workflows directory not found")

        src = os.path.join(_trash_dir(base), token)
        if not os.path.exists(src):
            return web.Response(status=404, text="Trash entry not found")

        target = _resolve_safe(base, dest_rel)
        if not target:
            return web.Response(status=403, text="Forbidden")
        if os.path.exists(target):
            return web.Response(status=409, text="Destination already exists")

        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.move(src, target)

        sidecar = _trash_colors_sidecar(_trash_dir(base), token)
        if os.path.isfile(sidecar):
            try:
                with open(sidecar, encoding="utf-8") as f:
                    popped = json.load(f)
                new_key, _ = _color_key_from_rel(dest_rel)
                async with _meta_lock:
                    _restore_colors(base, popped, new_key)
            finally:
                try:
                    os.remove(sidecar)
                except Exception:
                    pass

        return web.Response(status=200)
    except Exception as e:
        return web.Response(status=500, text=str(e))


@PromptServer.instance.routes.get("/wfo/colors")
async def get_colors(request):
    """Return the folder→hex-color map (keys relative to the workflows dir)."""
    try:
        base = _get_user_base(request)
        if not base:
            return web.json_response({})
        return web.json_response(_load_meta(base).get("colors", {}))
    except Exception:
        return web.json_response({})


@PromptServer.instance.routes.post("/wfo/colors")
async def set_color(request):
    """Set (or clear, when color is empty) a folder's color."""
    try:
        if not _require_json_content_type(request):
            return web.Response(status=400, text="Content-Type must be application/json")
        data = await request.json()
        rel = data.get("path", "").replace("\\", "/").strip("/")
        color = (data.get("color") or "").strip()
        if not rel or ".." in rel.split("/") or not _valid_color_key(rel):
            return web.Response(status=400, text="Invalid path")
        if color and not _valid_color(color):
            return web.Response(status=400, text="Invalid color")

        base = _get_user_base(request)
        if not base:
            return web.Response(status=404, text="Workflows directory not found")

        async with _meta_lock:
            meta = _load_meta(base)
            colors = meta.get("colors", {})
            if color:
                if rel not in colors and len(colors) >= MAX_COLOR_ENTRIES:
                    return web.Response(status=400, text="Too many colored folders")
                colors[rel] = color
            else:
                colors.pop(rel, None)
            meta["colors"] = colors
            _save_meta(base, meta)
        return web.Response(status=200)
    except Exception as e:
        return web.Response(status=500, text=str(e))


@PromptServer.instance.routes.post("/wfo/colors/bulk")
async def set_colors_bulk(request):
    """Replace the entire folder->color map (used by 'Apply to all' + its undo)."""
    try:
        if not _require_json_content_type(request):
            return web.Response(status=400, text="Content-Type must be application/json")
        data = await request.json()
        incoming = data.get("colors", {})
        if not isinstance(incoming, dict):
            return web.Response(status=400, text="Invalid colors")

        clean = {}
        for rel, color in incoming.items():
            if len(clean) >= MAX_COLOR_ENTRIES:
                break
            rel = str(rel).replace("\\", "/").strip("/")
            color = (color or "").strip()
            if not rel or ".." in rel.split("/") or not _valid_color_key(rel):
                continue
            if color and not _valid_color(color):
                continue
            if color:
                clean[rel] = color

        base = _get_user_base(request)
        if not base:
            return web.Response(status=404, text="Workflows directory not found")

        async with _meta_lock:
            meta = _load_meta(base)
            meta["colors"] = clean
            _save_meta(base, meta)
        return web.Response(status=200)
    except Exception as e:
        return web.Response(status=500, text=str(e))


@PromptServer.instance.routes.post("/wfo/ensure-placeholders")
async def ensure_placeholders(request):
    """Walk the workflows dir; add placeholder.json to any folder missing one.
    Only touches folders that actually exist on disk — never recreates a
    renamed or deleted folder. Returns how many placeholders were created."""
    try:
        base = _get_user_base(request)
        if not base:
            return web.json_response({"created": 0})

        workflows_root = os.path.join(base, "workflows")
        if not os.path.isdir(workflows_root):
            return web.json_response({"created": 0})

        created = 0
        # Folders whose only visible content is genuinely OUR placeholder —
        # verified by content, not just the filename "placeholder.json", so a
        # real user workflow that happens to be named "placeholder" (the only
        # case a name-only check can't tell apart) is never mistaken for one.
        placeholder_only = []
        for dirpath, dirnames, filenames in os.walk(workflows_root):
            if dirpath == workflows_root:
                continue  # root itself never needs a placeholder
            visible = [f for f in filenames if not f.startswith(".")]
            placeholder = os.path.join(dirpath, "placeholder.json")
            rel = os.path.relpath(dirpath, workflows_root).replace("\\", "/")
            if not visible and not dirnames:
                if not os.path.exists(placeholder):
                    with open(placeholder, "w", encoding="utf-8") as f:
                        json.dump({"wfo_placeholder": True}, f)
                    created += 1
                placeholder_only.append(rel)
            elif dirnames and "placeholder.json" in filenames:
                # A folder gained a subfolder after it was created (which always
                # gets an immediate placeholder so it's visible while still
                # empty) — that placeholder is now stale, remove it.
                try:
                    os.remove(placeholder)
                except OSError:
                    pass
            elif visible == ["placeholder.json"] and not dirnames:
                # Ambiguous: the only file is named placeholder.json, but that
                # alone doesn't prove it's ours — check the actual content.
                try:
                    with open(placeholder, encoding="utf-8") as f:
                        data = json.load(f)
                    if isinstance(data, dict) and data.get("wfo_placeholder") is True:
                        placeholder_only.append(rel)
                except Exception:
                    pass

        return web.json_response({"created": created, "placeholder_only": placeholder_only})
    except Exception as e:
        return web.Response(status=500, text=str(e))


@PromptServer.instance.routes.post("/wfo/folder/rename")
async def rename_wfo_folder(request):
    try:
        if not _require_json_content_type(request):
            return web.Response(status=400, text="Content-Type must be application/json")
        data = await request.json()
        old_rel = data.get("old", "").replace("\\", "/").strip("/")
        new_rel = data.get("new", "").replace("\\", "/").strip("/")
        if (not old_rel or not new_rel or ".." in old_rel.split("/") or ".." in new_rel.split("/")
                or not _in_workflows(old_rel) or not _in_workflows(new_rel)):
            return web.Response(status=400, text="Invalid path")
        if not all(_valid_name(seg) for seg in new_rel.split("/")[1:]):
            return web.Response(status=400, text="Invalid name")
        if new_rel == old_rel or new_rel.startswith(old_rel + "/"):
            return web.Response(status=400, text="Cannot move a folder into itself or a descendant")

        base = _get_user_base(request)
        if not base:
            return web.Response(status=404, text="Workflows directory not found")

        src = _resolve_safe(base, old_rel)
        dst = _resolve_safe(base, new_rel)
        if not src or not dst:
            return web.Response(status=403, text="Forbidden")
        if not os.path.exists(src):
            return web.Response(status=404, text="Not found")
        # On case-insensitive filesystems (Windows/macOS), os.path.exists(dst) is
        # True for a pure case change ("Foo" -> "foo") since it's the same file —
        # only treat it as a real conflict when it resolves to a *different* path.
        if os.path.exists(dst) and os.path.normcase(src) != os.path.normcase(dst):
            return web.Response(status=409, text="Destination already exists")

        was_dir = os.path.isdir(src)
        os.rename(src, dst)
        async with _meta_lock:
            if was_dir:
                _remap_color_keys(base, old_rel, new_rel)
            else:
                _remap_file_color_key(base, old_rel, new_rel)
        return web.Response(status=200)
    except Exception as e:
        return web.Response(status=500, text=str(e))


@PromptServer.instance.routes.get("/wfo/file/colors")
async def get_file_colors(request):
    try:
        base = _get_user_base(request)
        if not base:
            return web.json_response({})
        return web.json_response(_load_meta(base).get("file_colors", {}))
    except Exception:
        return web.json_response({})


@PromptServer.instance.routes.post("/wfo/file/colors")
async def set_file_color(request):
    try:
        if not _require_json_content_type(request):
            return web.Response(status=400, text="Content-Type must be application/json")
        data = await request.json()
        rel = data.get("path", "").replace("\\", "/").strip("/")
        color = (data.get("color") or "").strip()
        if not rel or ".." in rel.split("/") or not _valid_color_key(rel):
            return web.Response(status=400, text="Invalid path")
        if color and not _valid_color(color):
            return web.Response(status=400, text="Invalid color")

        base = _get_user_base(request)
        if not base:
            return web.Response(status=404, text="Workflows directory not found")

        async with _meta_lock:
            meta = _load_meta(base)
            file_colors = meta.get("file_colors", {})
            if color:
                if rel not in file_colors and len(file_colors) >= MAX_COLOR_ENTRIES:
                    return web.Response(status=400, text="Too many colored files")
                file_colors[rel] = color
            else:
                file_colors.pop(rel, None)
            meta["file_colors"] = file_colors
            _save_meta(base, meta)
        return web.Response(status=200)
    except Exception as e:
        return web.Response(status=500, text=str(e))


@PromptServer.instance.routes.post("/wfo/file/copy")
async def copy_wfo_file(request):
    try:
        if not _require_json_content_type(request):
            return web.Response(status=400, text="Content-Type must be application/json")
        data = await request.json()
        rel = data.get("path", "").replace("\\", "/").strip("/")
        if not rel or ".." in rel.split("/") or not _in_workflows(rel):
            return web.Response(status=400, text="Invalid path")

        base = _get_user_base(request)
        if not base:
            return web.Response(status=404, text="Workflows directory not found")

        src = _resolve_safe(base, rel)
        if not src or not os.path.isfile(src):
            return web.Response(status=404, text="File not found")

        stem, ext = os.path.splitext(os.path.basename(src))
        parent = os.path.dirname(src)
        copy_name = f"{stem} copy{ext}"
        counter = 2
        while True:
            dst = os.path.join(parent, copy_name)
            try:
                # O_EXCL atomically reserves the name — closes the TOCTOU window
                # where two concurrent duplicates could both pick the same name
                # and the second shutil.copy2 would silently clobber the first.
                fd = os.open(dst, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.close(fd)
                break
            except FileExistsError:
                copy_name = f"{stem} copy {counter}{ext}"
                counter += 1

        shutil.copy2(src, dst)
        return web.json_response({"new_name": copy_name})
    except Exception as e:
        return web.Response(status=500, text=str(e))


@PromptServer.instance.routes.post("/wfo/folder/copy")
async def copy_wfo_folder(request):
    try:
        if not _require_json_content_type(request):
            return web.Response(status=400, text="Content-Type must be application/json")
        data = await request.json()
        rel = data.get("path", "").replace("\\", "/").strip("/")
        if not rel or ".." in rel.split("/") or not _in_workflows(rel):
            return web.Response(status=400, text="Invalid path")

        base = _get_user_base(request)
        if not base:
            return web.Response(status=404, text="Workflows directory not found")

        src = _resolve_safe(base, rel)
        if not src or not os.path.isdir(src):
            return web.Response(status=404, text="Folder not found")

        folder_name = os.path.basename(src)
        parent = os.path.dirname(src)
        copy_name = f"{folder_name} copy"
        counter = 2
        while True:
            dst = os.path.join(parent, copy_name)
            try:
                # copytree refuses an existing dst by default, so retrying on
                # FileExistsError (rather than pre-checking os.path.exists) closes
                # the TOCTOU window between two concurrent duplicates.
                shutil.copytree(src, dst)
                break
            except FileExistsError:
                copy_name = f"{folder_name} copy {counter}"
                counter += 1

        return web.json_response({"new_name": copy_name})
    except Exception as e:
        return web.Response(status=500, text=str(e))


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
