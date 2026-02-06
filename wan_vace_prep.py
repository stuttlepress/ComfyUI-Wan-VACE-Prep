import torch

class WanVACEPrep:    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video_1": ("IMAGE",),
                "video_2": ("IMAGE",),
                "context_frames": ("INT", {
                    "default": 8,
                    "min": 4,
                    "max": 120,
                    "step": 4,
                    "tooltip": "Reference frames from each video edge for VACE interpolation (multiple of 4)."
                }),
                "replace_frames": ("INT", {
                    "default": 8,
                    "min": 0,
                    "max": 120,
                    "step": 4,
                    "tooltip": "Number of frames to regenerate at each transition edge (multiple of 4)."
                }),
                "add_frames": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 240,
                    "step": 4,
                    "tooltip": "Number of new transition frames to generate, in addition to the replace_frames (multiple of 4)."
                }),
            }
        }
    
    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT", "INT", "IMAGE", "IMAGE")
    RETURN_NAMES = ("control_video", "control_mask", "width", "height", "length", "start_images", "end_images")
    FUNCTION = "vace_prep"
    CATEGORY = "video/VACE"
    DESCRIPTION = "Generates VACE control video and mask for smooth transitions between two videos using context frames and frame replacement."
    
    def vace_prep(self, video_1, video_2, context_frames, replace_frames, add_frames):
        height = int(video_1.shape[1])
        width = int(video_1.shape[2])
                
        if video_2.shape[1] != height or video_2.shape[2] != width:
            raise ValueError(
                f"Video dimensions must match. "
                f"video_1 is {width}x{height}, video_2 is {int(video_2.shape[2])}x{int(video_2.shape[1])}"
            )
        
        if width % 16 != 0 or height % 16 != 0:
            raise ValueError(
                f"Video dimensions must be divisible by 16. "
                f"Current dimensions: {width}x{height}"
            )
        
        v1_len = video_1.shape[0]
        v2_len = video_2.shape[0]
        required_frames = context_frames + replace_frames
        
        if v1_len < required_frames:
            raise ValueError(
                f"context_frames ({context_frames}) + replace_frames ({replace_frames}) = {required_frames}, "
                f"which is too large for video_1 length of {v1_len}. "
                f"Reduce context_frames or replace_frames."
            )
        
        if v2_len < required_frames:
            raise ValueError(
                f"context_frames ({context_frames}) + replace_frames ({replace_frames}) = {required_frames}, "
                f"which is too large for video_2 length of {v2_len}. "
                f"Reduce context_frames or replace_frames."
            )
        
        if replace_frames > 0:
            v1_context = video_1[-(context_frames + replace_frames):-replace_frames]
            v2_context = video_2[replace_frames:context_frames + replace_frames]
        else:
            v1_context = video_1[-context_frames:]
            v2_context = video_2[:context_frames]
        
        channels = video_1.shape[3]
        
        # Wan wants to generate 4n+1 frames. If we don't provide that, 
        # it will quietly round down to the nearest 4n+1. So we add 1 here.
        vace_count = (replace_frames * 2) + add_frames + 1
        vace_frames = torch.full((vace_count, height, width, channels), 0.5, dtype=video_1.dtype, device=video_1.device)
        
        control_video = torch.cat([v1_context, vace_frames, v2_context], dim=0)
        
        total_frames = (context_frames * 2) + vace_count
        mask = torch.zeros((total_frames, height, width), dtype=torch.float32, device=video_1.device)
        mask[context_frames:context_frames + vace_count] = 1.0
        
        start_images = video_1[:-(context_frames + replace_frames)]
        end_images = video_2[context_frames + replace_frames:]
        
        length = int(control_video.shape[0])

        return (control_video, mask, width, height, length, start_images, end_images)


NODE_CLASS_MAPPINGS = {
    "WanVACEPrep": WanVACEPrep
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WanVACEPrep": "Wan VACE Prep"
}