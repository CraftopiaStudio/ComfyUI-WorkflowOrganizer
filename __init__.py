"""
ComfyUI-WorkflowOrganizer
Adds drag-and-drop support to the Workflows sidebar.
"""

from server import PromptServer
from aiohttp import web
import folder_paths
import json
import os
import shutil
import time

WEB_DIRECTORY = "./js"

TRASH_DIRNAME = ".wfo_trash"
TRASH_MAX_AGE_DAYS = 7


def _trash_dir(base):
    """Hidden trash directory beside the workflows folder (never in the tree)."""
    return os.path.join(base, TRASH_DIRNAME)


def _prune_trash(trash):
    """Remove trash entries older than TRASH_MAX_AGE_DAYS."""
    if not os.path.isdir(trash):
        return
    cutoff = time.time() - TRASH_MAX_AGE_DAYS * 86400
    for name in os.listdir(trash):
        p = os.path.join(trash, name)
        try:
            if os.path.getmtime(p) < cutoff:
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
    use). Falls back to the first user dir that has a workflows folder, which is
    correct for the common single-user ('default') setup.
    """
    user_root = _user_root()

    if request is not None:
        try:
            user_id = PromptServer.instance.user_manager.get_request_user_id(request)
            if user_id:
                cand = os.path.join(user_root, user_id)
                if os.path.isdir(cand):
                    return cand
        except Exception:
            pass

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


def _save_meta(base, data):
    try:
        with open(_meta_file(base), "w", encoding="utf-8") as fh:
            json.dump(data, fh)
    except Exception:
        pass


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
    colors = meta.get("colors", {})
    changed = False
    for key in list(colors.keys()):
        if key == old_rel:
            colors[new_rel] = colors.pop(key)
            changed = True
        elif key.startswith(old_rel + "/"):
            colors[new_rel + key[len(old_rel):]] = colors.pop(key)
            changed = True
    if changed:
        meta["colors"] = colors
        _save_meta(base, meta)


@PromptServer.instance.routes.post("/wfo/folder")
async def create_wfo_folder(request):
    try:
        data = await request.json()
        rel = data.get("path", "").replace("\\", "/").strip("/")
        if not rel or ".." in rel.split("/"):
            return web.Response(status=400, text="Invalid path")

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
        data = await request.json()
        rel = data.get("path", "").replace("\\", "/").strip("/")
        recursive = data.get("recursive", False)
        if not rel or ".." in rel.split("/"):
            return web.Response(status=400, text="Invalid path")

        base = _get_user_base(request)
        if not base:
            return web.Response(status=404, text="Workflows directory not found")

        target = _resolve_safe(base, rel)
        if not target or not os.path.isdir(target):
            return web.Response(status=404, text="Folder not found")

        if recursive:
            # Move to a hidden trash dir instead of deleting, so it can be undone
            trash = _trash_dir(base)
            os.makedirs(trash, exist_ok=True)
            _prune_trash(trash)
            token = "%d_%s" % (int(time.time() * 1000), os.path.basename(target))
            shutil.move(target, os.path.join(trash, token))
            return web.json_response({"trash": token})

        placeholder = os.path.join(target, "placeholder.json")
        if os.path.exists(placeholder):
            os.remove(placeholder)
        contents = [f for f in os.listdir(target) if not f.startswith(".")]
        if not contents:
            try:
                os.rmdir(target)
            except OSError:
                pass
        return web.Response(status=200)
    except Exception as e:
        return web.Response(status=500, text=str(e))


@PromptServer.instance.routes.post("/wfo/trash")
async def trash_path(request):
    """Move a file or folder to the hidden trash; return its trash token.
    Works for single workflows (used by bulk delete) and folders alike."""
    try:
        data = await request.json()
        rel = data.get("path", "").replace("\\", "/").strip("/")
        if not rel or ".." in rel.split("/"):
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
        token = "%d_%s" % (int(time.time() * 1000), os.path.basename(target))
        shutil.move(target, os.path.join(trash, token))
        return web.json_response({"trash": token})
    except Exception as e:
        return web.Response(status=500, text=str(e))


@PromptServer.instance.routes.post("/wfo/trash/restore")
async def restore_trash(request):
    """Move a trashed file or folder back to its original location (undo delete)."""
    try:
        data = await request.json()
        token = data.get("trash", "")
        dest_rel = data.get("dest", "").replace("\\", "/").strip("/")
        # token must be a single path segment (no traversal)
        if not token or "/" in token or "\\" in token or ".." in token:
            return web.Response(status=400, text="Invalid trash token")
        if not dest_rel or ".." in dest_rel.split("/"):
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
        data = await request.json()
        rel = data.get("path", "").replace("\\", "/").strip("/")
        color = (data.get("color") or "").strip()
        if not rel or ".." in rel.split("/"):
            return web.Response(status=400, text="Invalid path")
        # basic hex validation when setting
        if color and not (color.startswith("#") and len(color) in (4, 7)):
            return web.Response(status=400, text="Invalid color")

        base = _get_user_base(request)
        if not base:
            return web.Response(status=404, text="Workflows directory not found")

        meta = _load_meta(base)
        colors = meta.get("colors", {})
        if color:
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
        data = await request.json()
        incoming = data.get("colors", {})
        if not isinstance(incoming, dict):
            return web.Response(status=400, text="Invalid colors")

        clean = {}
        for rel, color in incoming.items():
            rel = str(rel).replace("\\", "/").strip("/")
            color = (color or "").strip()
            if not rel or ".." in rel.split("/"):
                continue
            if color and not (color.startswith("#") and len(color) in (4, 7)):
                continue
            if color:
                clean[rel] = color

        base = _get_user_base(request)
        if not base:
            return web.Response(status=404, text="Workflows directory not found")

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
        for dirpath, dirnames, filenames in os.walk(workflows_root):
            if dirpath == workflows_root:
                continue  # root itself never needs a placeholder
            visible = [f for f in filenames if not f.startswith(".")]
            if not visible:
                placeholder = os.path.join(dirpath, "placeholder.json")
                with open(placeholder, "w", encoding="utf-8") as f:
                    json.dump({"wfo_placeholder": True}, f)
                created += 1

        return web.json_response({"created": created})
    except Exception as e:
        return web.Response(status=500, text=str(e))


@PromptServer.instance.routes.post("/wfo/folder/rename")
async def rename_wfo_folder(request):
    try:
        data = await request.json()
        old_rel = data.get("old", "").replace("\\", "/").strip("/")
        new_rel = data.get("new", "").replace("\\", "/").strip("/")
        if not old_rel or not new_rel or ".." in old_rel.split("/") or ".." in new_rel.split("/"):
            return web.Response(status=400, text="Invalid path")

        base = _get_user_base(request)
        if not base:
            return web.Response(status=404, text="Workflows directory not found")

        src = _resolve_safe(base, old_rel)
        dst = _resolve_safe(base, new_rel)
        if not src or not dst:
            return web.Response(status=403, text="Forbidden")
        if not os.path.isdir(src):
            return web.Response(status=404, text="Folder not found")
        if os.path.exists(dst):
            return web.Response(status=409, text="Destination already exists")

        os.rename(src, dst)
        _remap_color_keys(base, old_rel, new_rel)
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
        data = await request.json()
        rel = data.get("path", "").replace("\\", "/").strip("/")
        color = (data.get("color") or "").strip()
        if not rel or ".." in rel.split("/"):
            return web.Response(status=400, text="Invalid path")
        if color and not (color.startswith("#") and len(color) in (4, 7)):
            return web.Response(status=400, text="Invalid color")

        base = _get_user_base(request)
        if not base:
            return web.Response(status=404, text="Workflows directory not found")

        meta = _load_meta(base)
        file_colors = meta.get("file_colors", {})
        if color:
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
        data = await request.json()
        rel = data.get("path", "").replace("\\", "/").strip("/")
        if not rel or ".." in rel.split("/"):
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
        dst = os.path.join(parent, copy_name)
        counter = 2
        while os.path.exists(dst):
            copy_name = f"{stem} copy {counter}{ext}"
            dst = os.path.join(parent, copy_name)
            counter += 1

        shutil.copy2(src, dst)
        return web.json_response({"new_name": copy_name})
    except Exception as e:
        return web.Response(status=500, text=str(e))


@PromptServer.instance.routes.post("/wfo/folder/copy")
async def copy_wfo_folder(request):
    try:
        data = await request.json()
        rel = data.get("path", "").replace("\\", "/").strip("/")
        if not rel or ".." in rel.split("/"):
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
        dst = os.path.join(parent, copy_name)
        counter = 2
        while os.path.exists(dst):
            copy_name = f"{folder_name} copy {counter}"
            dst = os.path.join(parent, copy_name)
            counter += 1

        shutil.copytree(src, dst)
        return web.json_response({"new_name": copy_name})
    except Exception as e:
        return web.Response(status=500, text=str(e))


class WorkflowOrganizerInfo:
    """Dummy node — exists only so ComfyUI loads the JS extension."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "CraftKit/utils"
    OUTPUT_NODE = True

    def noop(self):
        return ()


NODE_CLASS_MAPPINGS = {
    "WorkflowOrganizerInfo": WorkflowOrganizerInfo,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "WorkflowOrganizerInfo": "Workflow Organizer Info 📂",
}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
