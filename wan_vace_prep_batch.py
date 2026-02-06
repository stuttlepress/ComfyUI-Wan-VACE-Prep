import torch

class WanVACEPrepBatch:    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video_1": ("IMAGE",),
                "video_2": ("IMAGE",),             
                "is_first": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "True for first iteration (index=0) - includes full beginning of video_1 in start_images."
                }),
                "is_last": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "True for last iteration - includes full ending of video_2 in end_images."
                }),                
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
                "new_frames": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 240,
                    "step": 4,
                    "tooltip": "Number of new transition frames to generate, in addition to the replace_frames (multiple of 4)."
                }),
                "debug": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Log details to the console"
                }),
            }
        }
    
    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT", "INT", "IMAGE", "IMAGE")
    RETURN_NAMES = ("control_video", "control_mask", "width", "height", "length", "start_images", "end_images")
    FUNCTION = "vace_prep_batch"
    CATEGORY = "video/VACE"
    DESCRIPTION = "Batch-aware VACE prep that handles first/last iteration edge cases for multi-video processing."
    
    def vace_prep_batch(self, video_1, video_2, context_frames, replace_frames, new_frames, is_first, is_last, debug=False):
        height = int(video_1.shape[1])
        width = int(video_1.shape[2])
        
        if debug:
            print(f"\n=== Wan VACE Prep Batch ===")
            print(f"Video 1: {video_1.shape[0]} frames @ {width}x{height}")
            print(f"Video 2: {video_2.shape[0]} frames @ {width}x{height}")
            print(f"Flags: {'FIRST ' if is_first else ''}{'LAST' if is_last else 'MIDDLE' if not is_first else ''}")
            print(f"Parameters: context={context_frames}, replace={replace_frames}, new={new_frames}")
                   
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
        
        # Validation for video_1
        if is_first:
            if v1_len < required_frames:
                raise ValueError(
                    f"First iteration: video_1 needs at least {required_frames} frames "
                    f"(context_frames + replace_frames), but has {v1_len}"
                )
        else:
            if v1_len < required_frames * 2:
                raise ValueError(
                    f"Middle/last iteration: video_1 needs at least {required_frames * 2} frames, "
                    f"but has {v1_len}"
                )
        
        # Validation for video_2
        if v2_len < required_frames:
            raise ValueError(
                f"video_2 needs at least {required_frames} frames "
                f"(context_frames + replace_frames), but has {v2_len}"
            )
        
        # Extract context frames for control video/mask
        if replace_frames > 0:
            v1_context = video_1[-(context_frames + replace_frames):-replace_frames]
            v2_context = video_2[replace_frames:context_frames + replace_frames]
        else:
            v1_context = video_1[-context_frames:]
            v2_context = video_2[:context_frames]
        
        channels = video_1.shape[3]
        
        # Generate VACE frames placeholder (4n+1 frames)
        vace_count = (replace_frames * 2) + new_frames + 1
        vace_frames = torch.full((vace_count, height, width, channels), 0.5, dtype=video_1.dtype, device=video_1.device)
        
        control_video = torch.cat([v1_context, vace_frames, v2_context], dim=0)
        
        total_frames = (context_frames * 2) + vace_count
        mask = torch.zeros((total_frames, height, width), dtype=torch.float32, device=video_1.device)
        mask[context_frames:context_frames + vace_count] = 1.0
        
        # Extract start_images (frames to save from video_1)
        if is_first:
            # Keep everything except last (context + replace)
            start_images = video_1[:-required_frames]
        else:
            # Skip first (context + replace), keep rest except last (context + replace)
            start_images = video_1[required_frames:-required_frames]
        
        # Extract end_images (frames to save from video_2, only on last iteration)
        if is_last:
            end_images = video_2[required_frames:]
        else:
            # Return empty batch for non-last iterations
            end_images = torch.empty((0, height, width, channels), dtype=video_2.dtype, device=video_2.device)
        
        length = int(control_video.shape[0])
           
        if debug:
            print(f"\nOutputs:")
            print(f"  control_video: {control_video.shape}")
            print(f"  control_mask: {mask.shape}")
            print(f"  start_images: {start_images.shape[0]} frames")
            print(f"  end_images: {end_images.shape[0]} frames")
            print(f"  VACE output: {total_frames} frames ({context_frames * 2} context + {vace_count} generated")
            print(f"===========================\n")

        return (control_video, mask, width, height, length, start_images, end_images)


NODE_CLASS_MAPPINGS = {
    "WanVACEPrepBatch": WanVACEPrepBatch
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WanVACEPrepBatch": "Wan VACE Prep Batch"
}