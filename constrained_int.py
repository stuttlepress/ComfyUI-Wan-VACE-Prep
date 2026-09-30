import sys

from comfy_api.latest import io


INT_MIN = -sys.maxsize
INT_MAX = sys.maxsize
# Constraint widgets round-trip through JS doubles, so their range stops at
# Number.MAX_SAFE_INTEGER. A min or max at that limit means "not set".
SAFE_INT = 2**53 - 1


def snap_int(value: int, lo: int, hi: int, step: int) -> int:
    """Snap value to the nearest step inside [lo, hi].

    The step grid is anchored at lo when a min is set, otherwise at 0.
    Mirrors snapInt in web/constrained_int.js - keep the two in step.
    """
    lo_set = lo > -SAFE_INT
    lo = lo if lo_set else INT_MIN
    hi = hi if hi < SAFE_INT else INT_MAX
    if lo > hi:
        raise ValueError(f"min ({lo}) is greater than max ({hi})")
    step = max(1, step)
    base = lo if lo_set else 0

    # Nearest grid point, ties rounding up. Integer math only: values reach 2^63.
    q, r = divmod(value - base, step)
    if 2 * r >= step:
        q += 1
    snapped = base + q * step

    lo_grid = base - ((base - lo) // step) * step   # smallest grid point >= lo
    hi_grid = base + ((hi - base) // step) * step   # largest grid point <= hi
    if lo_grid > hi_grid:
        raise ValueError(f"no multiple of step {step} lies between min {lo} and max {hi}")
    return min(max(snapped, lo_grid), hi_grid)


class ConstrainedInt(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="ConstrainedInt",
            display_name="🪐 Int (Constrained)",
            category="Wan VACE Prep/utils",
            description="An Int primitive with per-node min, max and step constraints. The value is "
                        "snapped to the nearest step inside [min, max]. The constraints are advanced "
                        "inputs, edited in the properties panel (Nodes 2.0) or the legacy Properties Panel.",
            inputs=[
                io.Int.Input("value", default=0, min=INT_MIN, max=INT_MAX,
                             control_after_generate=io.ControlAfterGenerate.fixed),
                io.Int.Input("min_value", display_name="min", default=-SAFE_INT, min=-SAFE_INT, max=SAFE_INT,
                             tooltip="Lowest allowed value. Also anchors the step grid when set.",
                             advanced=True, socketless=True),
                io.Int.Input("max_value", display_name="max", default=SAFE_INT, min=-SAFE_INT, max=SAFE_INT,
                             tooltip="Highest allowed value.",
                             advanced=True, socketless=True),
                io.Int.Input("step", default=1, min=1, max=SAFE_INT,
                             tooltip="Values snap to the nearest multiple of step (counted from min "
                                     "when min is set, else from 0). 1 means no snapping.",
                             advanced=True, socketless=True),
            ],
            outputs=[io.Int.Output()],
        )

    @classmethod
    def execute(cls, value: int, min_value: int, max_value: int, step: int) -> io.NodeOutput:
        return io.NodeOutput(snap_int(value, min_value, max_value, step))
