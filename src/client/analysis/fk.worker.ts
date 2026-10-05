import { deriveForward } from "../../kinematics/forward";

// Admission and all numeric work run in this dedicated browser Worker.
self.onmessage = (event: MessageEvent<unknown>) => {
  self.postMessage(deriveForward(event.data));
};
