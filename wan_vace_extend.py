import torch

class WanVACEExtend:
    """Generates VACE control video and mask for extending a video from an arbitrary frame using context frames."""
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("IMAGE",),
                "extend_from_idx": ("INT", {
                    "default": -1,
                    "min": -999999,
                    "max": 999999,
                    "step": 1,
                    "tooltip": "Frame index to extend from. Negative values count from the end of the video. e.g., -1 is last frame"
                }),
                "context_frames": ("INT", {
                    "default": 8,
                    "min": 4,
                    "max": 120,
                    "step": 4,
                    "tooltip": "Number of reference frames before extend_from_idx for VACE conditioning (multiple of 4)."
                }),
                "new_frames": ("INT", {
                    "default": 25,
                    "min": 1,
                    "max": 241,
                    "step": 4,
                    "tooltip": "Number of new frames to generate (4n+1)."
                }),
                "crossfade_mode": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Include context frames in start_images for cross-fade or other workflow use cases."
                }),
            }
        }
    
    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT", "INT", "IMAGE")
    RETURN_NAMES = ("control_video", "control_mask", "width", "height", "length", "start_images")
    FUNCTION = "vace_extend"
    CATEGORY = "video/VACE"
    
    def vace_extend(self, video, extend_from_idx, context_frames, new_frames, crossfade_mode):
        height = int(video.shape[1])
        width = int(video.shape[2])
        video_length = video.shape[0]
        
        if width % 16 != 0 or height % 16 != 0:
            raise ValueError(
                f"Video dimensions must be divisible by 16. "
                f"Current dimensions: {width}x{height}"
            )
        
        if (new_frames - 1) % 4 != 0:
            raise ValueError(
                f"new_frames must follow 4n+1 pattern (1, 5, 9, 13, 17, 21, 25, ...). "
                f"Got {new_frames}. "
                f"Nearest valid values: {((new_frames - 1) // 4) * 4 + 1} or {((new_frames - 1) // 4 + 1) * 4 + 1}"
            )
        
        if extend_from_idx < 0:
            actual_extend_idx = video_length + extend_from_idx
        else:
            actual_extend_idx = extend_from_idx
        
        if actual_extend_idx < 0 or actual_extend_idx >= video_length:
            raise ValueError(
                f"extend_from_idx resolves to {actual_extend_idx}, which is out of bounds for video length {video_length}. "
                f"Valid range: 0 to {video_length - 1} (or -{video_length} to -1 for negative indexing)."
            )
        
        if context_frames > actual_extend_idx:
            raise ValueError(
                f"context_frames ({context_frames}) requires at least {context_frames} frames before extend_from_idx, "
                f"but extend_from_idx is at position {actual_extend_idx}. "
                f"Maximum context_frames for this position: {actual_extend_idx}"
            )
        
        if context_frames > 0:
            context_start = actual_extend_idx - context_frames
            video_context = video[context_start:actual_extend_idx]
        else:
            video_context = torch.empty((0, height, width, video.shape[3]), dtype=video.dtype, device=video.device)
        
        channels = video.shape[3]
        
        vace_frames = torch.full((new_frames, height, width, channels), 0.5, dtype=video.dtype, device=video.device)
        
        if context_frames > 0:
            control_video = torch.cat([video_context, vace_frames], dim=0)
        else:
            control_video = vace_frames
        
        vace_count = context_frames + new_frames
        mask = torch.zeros((vace_count, height, width), dtype=torch.float32, device=video.device)
        mask[context_frames:] = 1.0
        
        if crossfade_mode:
            start_images = video[:actual_extend_idx]
        else:
            cut_point = actual_extend_idx - context_frames
            start_images = video[:cut_point]
        
        length = int(control_video.shape[0])

        return (control_video, mask, width, height, length, start_images)


NODE_CLASS_MAPPINGS = {
    "WanVACEExtend": WanVACEExtend
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WanVACEExtend": "Wan VACE Extend"
}
