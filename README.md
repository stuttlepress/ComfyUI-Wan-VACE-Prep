# Wan VACE Prep

ComfyUI nodes for preparing videos for Wan VACE generation - handles transitions and extensions with automatic control video generation.

## Quick Start

**What it does:** Automates the tedious parts of VACE workflows by generating control videos and masks for smooth video transitions and extensions.

**Install via ComfyUI Manager:** Search for "Wan VACE Prep" → Install → Restart

**Or clone this repository:**
```bash
cd /path/to/comfyui/custom_nodes
git clone https://github.com/stuttlepress/ComfyUI-Wan-VACE-Prep
```

## Nodes

### Wan VACE Prep
For smoothly joining two video clips together. Builds VACE controls for the transition using context frames from each clip to guide frame generation. 

- Builds VACE control video and mask from context frames in both clips
- Outputs video segments for final assembly
- Optional crossfade mode for artifact reduction in the surrounding workflow.

![Wan VACE Prep Node](assets/comfyui-wan-vace-prep.png)

**Parameters:**
|Parameter|Default|Description|
|-|-|-|
|context_frames|8|Reference frames from each video edge that VACE uses for interpolation. These frames guide the model and are preserved in the output. Must be a multiple of 4.|
|replace_frames|8|Number of frames at each transition edge to discard and regenerate. These create the actual transition blend zone. Must be a multiple of 4.|
|add_frames|0|Number of completely new frames to generate between the two clips, extending the transition duration. Must be 0 or a multiple of 4.|
|crossfade_mode|false| When enabled, context frames are included in start_images and end_images so they can be blended with the context frames included in the VACE generated clip. This can help mitigate color or brightness artifacts at the transition.|


**Outputs:**
|Output|Description|
|-|-|
|control_video|VACE control video input|
|control_mask|VACE control mask input|
|width, height, length|Control video dimensions|
|start_images|Video 1 segment that precedes context frames and the transition|
|end_images|Video 2 segment that comes after the transition and context frames|

---

### Wan VACE Extend
For smoothly extending a video. Context frames from before the chosen extension point are used to build a control video for VACE conditioning. 

- Extends from arbitrary frame position
- Builds VACE control video and mask from context frames in the input video
- Outputs video segment preceding the extension for video reassembly
- Optional crossfade mode for artifact reduction in the surrounding workflow.

![Wan VACE Prep Node](assets/comfyui-wan-vace-extend.png)


**Parameters:**

| Parameter | Default | Description |
|-|-|-|
| extend_from_idx | -1 | Frame to extend from (negative counts from end, e.g., -1 = last frame) |
| context_frames | 8 | Number of reference frames preceding extend_from_idx that VACE uses for interpolation. These frames guide the model and are preserved in the output. Must be a multiple of 4. |
| new_frames | 25 | Number of new frames to generate (must be 4n+1: e.g., 1, 5, 9, 13, 17, 25...) |
| crossfade_mode | false | When enabled, context frames are included in start_images so they can be blended with the context frames included in the VACE generated clip. This can help mitigate color or brightness artifacts at the transition. |

**Outputs:**
|Output|Description|
|-|-|
|control_video|VACE control video input|
|control_mask|VACE control mask input|
|width, height, length|Control video dimensions|
|start_images|Video segment that precedes the context frames and the start of the extension|

---
## Technical Note
The Wan model likes to generate 4n+1 frames at a time. If you ask it for some other amount, it will silently round your request down to the nearest 4n+1. For this reason, parameters are restricted to multiples of 4 or 4n+1 and when necessary, the node adds +1 to the number of generated frames. 

## License
MIT License - feel free to use, modify, and distribute.