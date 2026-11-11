import type { CompiledProfile } from "./contracts";
import {
  axisRotation, KinematicsError, multiplyTransforms, originTransform, poseFromTransform,
} from "./math";

/**
 * Row-major transforms on column vectors, positions in radians and translations in meters.
 * Returns inverse(referenceFromMount * mountFromOptical); every revolute needs a position.
 * The chain is compiled by compileMountChain, not an independently supplied graph.
 */
export function cameraFromReference(
  chain: readonly CompiledProfile["rightChain"][number][],
  positionsRad: ReadonlyMap<string, number>,
  mountFromOptical: readonly number[] | Float64Array,
): Float64Array {
  const mount = new Float64Array(mountFromOptical);
  poseFromTransform(mount);
  let referenceFromMount = originTransform({ xyz: [0, 0, 0], rpy: [0, 0, 0] });
  for (const joint of chain) {
    referenceFromMount = multiplyTransforms(referenceFromMount, originTransform(joint.origin));
    switch (joint.type) {
      case "fixed": break;
      case "revolute": {
        const position = positionsRad.get(joint.name);
        if (position === undefined) throw new KinematicsError("missing_joint");
        referenceFromMount = multiplyTransforms(referenceFromMount, axisRotation(joint.axis, position));
        break;
      }
      default: {
        const exhaustive: never = joint;
        return exhaustive;
      }
    }
  }
  const referenceFromOptical = multiplyTransforms(referenceFromMount, mount);
  const { translationM } = poseFromTransform(referenceFromOptical);
  // A rigid inverse is [R^T, -R^T t; 0, 1], not a negated translation.
  const inverse = new Float64Array(16);
  for (let row = 0; row < 3; row++) {
    let translation = 0;
    for (let col = 0; col < 3; col++) {
      const rotation = referenceFromOptical[col * 4 + row];
      const offset = translationM[col];
      if (rotation === undefined || offset === undefined) throw new KinematicsError("invalid_rotation");
      inverse[row * 4 + col] = rotation;
      translation -= rotation * offset;
    }
    inverse[row * 4 + 3] = translation;
  }
  inverse[15] = 1;
  poseFromTransform(inverse);
  return inverse;
}
