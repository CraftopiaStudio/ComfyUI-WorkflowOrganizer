"""
ComfyUI-WorkflowOrganizer
Adds drag-and-drop support to the Workflows sidebar.
Frontend-only extension — dummy node required for JS loading.
"""

WEB_DIRECTORY = "./js"


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
