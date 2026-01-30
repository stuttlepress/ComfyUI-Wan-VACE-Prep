import os
import cv2
import torch

class LoadVideosFromFolderSimple:   
    VIDEO_EXTENSIONS = ['webm', 'mp4', 'mkv', 'gif', 'mov']
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder_path": ("STRING", {"default": ""}),
            },
        }
    
    RETURN_TYPES = ["IMAGE"]
    RETURN_NAMES = ["images"]
    FUNCTION = "load_videos"
    CATEGORY = "video/utility"
    DESCRIPTION = """
    Load all videos from a folder. A simplified answer to 
    KJNodes' LoadVideosFromFolder, which depends on VideoHelperSuite
    and can have problems in some environments.
    - Formats: webm, mp4, mkv, gif, mov
    - All videos must have identical resolution
    """
    
    def load_videos(self, folder_path):
        folder_path = folder_path.strip().strip('"').strip("'")
    
        if not os.path.isdir(folder_path):
            raise ValueError(f"Folder does not exist: {folder_path}")
                   
        video_files = self._get_video_files(folder_path)
        
        if not video_files:
            raise ValueError(
                f"No video files found in {folder_path}\n"
                f"Supported formats: {', '.join(self.VIDEO_EXTENSIONS)}"
            )
        
        print(f"Loading {len(video_files)} videos from {folder_path}")  
        all_frames = []
        expected_shape = None
        
        for idx, video_path in enumerate(video_files):
            print(f"[{idx+1}/{len(video_files)}]: {os.path.basename(video_path)}", end=" ... ")
            
            frames = self._load_video_frames(video_path)
            
            # Check resolution consistency
            if expected_shape is None:
                expected_shape = frames.shape[1:3] 
            else:
                if frames.shape[1:3] != expected_shape:
                    raise RuntimeError(
                        f"\nResolution mismatch\n"
                        f"  Expected: {expected_shape[0]}x{expected_shape[1]} (from first video)\n"
                        f"  Got: {frames.shape[1]}x{frames.shape[2]} in {os.path.basename(video_path)}"
                    )
            
            all_frames.append(frames)
            print(f"{frames.shape[0]} frames")
        
        # Concatenate all frames
        print(f"\nConcatenating {len(video_files)} videos...")
        output = torch.cat(all_frames, dim=0)

        print(f"Done!\n")
        return (output,)
    
    def _get_video_files(self, folder_path):
        """Get sorted list of video files in the folder."""
        import re
        
        video_files = []
        
        # Single directory only
        for f in os.listdir(folder_path):
            full_path = os.path.join(folder_path, f)
            if os.path.isfile(full_path) and self._is_video_file(f):
                video_files.append(full_path)
        
        # Natural sort (handles numbers correctly: video1, video2, video10)
        def natural_sort_key(s):
            return [int(text) if text.isdigit() else text.lower()
                    for text in re.split('([0-9]+)', s)]
        
        return sorted(video_files, key=natural_sort_key)
    
    def _is_video_file(self, filename):
        """Check if file has a supported video extension."""
        ext = filename.split('.')[-1].lower() if '.' in filename else ''
        return ext in self.VIDEO_EXTENSIONS
    
    def _load_video_frames(self, video_path):
        """Load all frames from a video file using OpenCV."""
        cap = cv2.VideoCapture(video_path)
        
        if not cap.isOpened():
            raise RuntimeError(f"Failed to open video: {video_path}")
        
        frames = []
        
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            
            # Convert BGR to RGB
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            
            # Convert to float32 [0, 1] range
            frame_tensor = torch.from_numpy(frame_rgb).float() / 255.0
            
            frames.append(frame_tensor)
        
        cap.release()
        
        if not frames:
            raise RuntimeError(f"No frames extracted from {video_path}")
        
        # Stack into [num_frames, height, width, channels]
        return torch.stack(frames, dim=0)


# ComfyUI node registration
NODE_CLASS_MAPPINGS = {
    "LoadVideosFromFolderSimple": LoadVideosFromFolderSimple,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoadVideosFromFolderSimple": "Load Videos From Folder (Simple)",
}
