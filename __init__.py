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

WEB_DIRECTORY = "./js"


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
            shutil.rmtree(target)
        else:
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
        return web.Response(status=200)
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
