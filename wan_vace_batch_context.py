class WanVACEBatchContext:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input_list": ("STRING", {"forceInput": True}),
                "input_dir": ("STRING", {
                    "default": "",
                    "tooltip": "Directory containing input videos"
                }),
                "project_name": ("STRING", {
                    "default": ".",
                    "tooltip": "Project name - workflow files will be created under ComfyUI/output/project_name. Use period (.) for no project name."
                }),
                "index": ("INT", {
                    "default": 0,
                    "min": 0,
                    "tooltip": "Current iteration index (0 based)"
                }),
                "debug": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Log some details to the console"
                }),
            }
        }
    
    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "BOOLEAN", "BOOLEAN")
    RETURN_NAMES = ("work_dir", "workfile_prefix", "video_1_filename", "video_2_filename", "is_first", "is_last")
    FUNCTION = "setup_context"
    CATEGORY = "video/VACE"
    DESCRIPTION = "Establishes iteration context for batch video processing."
    INPUT_IS_LIST = True
    
    def setup_context(self, **kwargs):
        input_dir = kwargs.get('input_dir', [""])[0]
        input_list = kwargs.get('input_list', [])
        project_name = kwargs.get('project_name', [""])[0]
        index = kwargs.get('index', [0])[0]
        debug = kwargs.get('debug', [False])[0] 
        
        # Validate input list
        list_length = len(input_list)
        
        if list_length < 2:
            raise ValueError(
                f"Need at least 2 videos to create transitions, found {list_length}"
            )
        
        # Validate index bounds
        max_index = list_length - 2
        if index < 0 or index > max_index:
            raise ValueError(
                f"Index {index} out of range (valid: 0-{max_index} for {list_length} videos)"
            )
        
        # Construct paths
        work_dir = f"{project_name}/vace-work"
        padded_index = f"{index:03d}"
        workfile_prefix = f"{work_dir}/index{padded_index}"
        
        # Set iteration flags
        is_first = (index == 0)
        is_last = (index == max_index)
        
        # Extract filenames
        video_1_filename = f"{input_dir}/{input_list[index]}"
        video_2_filename = f"{input_dir}/{input_list[index + 1]}"
        
        if debug:
            print(f"\n=== VACE Batch Context ===")
            print(f"Index: {index} (videos {index+1}-{index+2} of {list_length})")
            print(f"{'[FIRST]' if is_first else ''} {'[LAST]' if is_last else ''}")
            print(f"Input directory: {input_dir}")
            print(f"Video 1: {input_list[index]}")
            print(f"Video 2: {input_list[index + 1]}")
            print(f"Work prefix: {workfile_prefix}")
            print(f"=========================\n")
        
        return (work_dir, workfile_prefix, video_1_filename, video_2_filename, is_first, is_last)


NODE_CLASS_MAPPINGS = {
    "WanVACEBatchContext": WanVACEBatchContext
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WanVACEBatchContext": "Wan VACE Batch Context"
}