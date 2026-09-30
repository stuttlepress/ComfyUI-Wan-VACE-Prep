"""
Wan VACE Prep - Custom nodes for preparing videos for Wan VACE generation
"""

from comfy_api.latest import ComfyExtension, io

from .vace_join import WanVACEPrep, WanVACEPrepBatch
from .vace_extend import WanVACEExtend
from .load_videos_from_folder import LoadVideosFromFolderSimple
from .vace_batch_context import WanVACEBatchContext
from .frame_number_overlay import FrameNumberOverlay
from .vace_inpaint import WanVACEInpaint
from .wan_first_middle_last_frame import WanFirstMiddleLastFrameToVideo
from .vace_first_middle_last import WanVACEFirstMiddleLast
from .vace_outpaint import VACEOutpaint
from .duration import Duration
from .constrained_int import ConstrainedInt

# Node display names come from each node's Schema.display_name, so no
# NODE_DISPLAY_NAME_MAPPINGS is needed here.


class WanVacePrepExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            WanVACEPrep,
            WanVACEPrepBatch,
            WanVACEExtend,
            LoadVideosFromFolderSimple,
            WanVACEBatchContext,
            FrameNumberOverlay,
            WanVACEInpaint,
            WanFirstMiddleLastFrameToVideo,
            WanVACEFirstMiddleLast,
            VACEOutpaint,
            Duration,
            ConstrainedInt,
        ]


async def comfy_entrypoint() -> WanVacePrepExtension:
    return WanVacePrepExtension()


WEB_DIRECTORY = "./web"

__all__ = ["comfy_entrypoint", "WEB_DIRECTORY"]
