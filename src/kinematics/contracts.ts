import { z } from "zod";

export const fkContractVersion = 1 as const;

const finite = z.number().finite();
const nonEmpty = z.string().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);
const vector3 = z.tuple([finite, finite, finite]);
const transformOriginSchema = z.object({
  xyz: vector3,
  rpy: vector3,
});

const unitAxisSchema = vector3.superRefine(([x, y, zValue], context) => {
  if (Math.abs(Math.hypot(x, y, zValue) - 1) > 1e-6) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Revolute joint axis must be unit length" });
  }
});
const chainJointShape = {
  name: nonEmpty,
  parentLink: nonEmpty,
  childLink: nonEmpty,
  origin: transformOriginSchema,
};
const compiledJointSchema = z.discriminatedUnion("type", [
  z.object({ ...chainJointShape, type: z.literal("revolute"), axis: unitAxisSchema }).strict(),
  z.object({ ...chainJointShape, type: z.literal("fixed") }).strict(),
]);
const armJointNames = {
  right: Array.from({ length: 7 }, (_, index) => `right_arm_${index}`),
  left: Array.from({ length: 7 }, (_, index) => `left_arm_${index}`),
} as const;

function armChainSchema(side: keyof typeof armJointNames) {
  return z.array(compiledJointSchema).min(8).superRefine((chain, context) => {
    const revolutes = chain.filter((joint) => joint.type === "revolute");
    const links = ["link_torso_5", ...chain.map((joint) => joint.childLink)];
    const tool = chain.at(-1);
    if (new Set(chain.map((joint) => joint.name)).size !== chain.length ||
        new Set(links).size !== links.length ||
        links.some((link) => link === "tool_right" || link === "tool_left") ||
        chain.some((joint, index) => joint.parentLink !== links[index]) ||
        revolutes.length !== 7 ||
        armJointNames[side].some((name, index) => revolutes[index]?.name !== name) ||
        tool?.type !== "fixed" || tool.name !== `tool_${side}` ||
        tool.parentLink !== `link_${side}_arm_6` || tool.childLink !== `ee_${side}`) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${side} chain requires connected unique root-to-tip joints, seven ordered arm revolutes and the terminal tool joint` });
    }
  });
}

export const compiledProfileSchema = z.object({
  schemaVersion: z.literal(fkContractVersion),
  profileHash: sha256,
  sourcePath: nonEmpty,
  model: nonEmpty,
  revision: nonEmpty,
  urdfSha256: sha256,
  rootLink: z.literal("link_torso_5"),
  tips: z.object({ right: z.literal("ee_right"), left: z.literal("ee_left") }),
  rightChain: armChainSchema("right"),
  leftChain: armChainSchema("left"),
}).strict().superRefine((profile, context) => {
  const joints = [...profile.rightChain, ...profile.leftChain];
  if (new Set(joints.map((joint) => joint.name)).size !== joints.length ||
      new Set(joints.map((joint) => joint.childLink)).size !== joints.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Arm chains must not share joints or child links" });
  }
});
export type CompiledProfile = z.infer<typeof compiledProfileSchema>;

export const fkDeclarationSchema = z.object({
  representation: z.literal("absolute_joint_position"),
  jointUnit: z.enum(["rad", "deg"]),
  convention: z.object({
    kind: z.literal("nominal_sign_zero"),
    nominalSignZeroConfirmed: z.literal(true),
    source: z.literal("user_declared"),
  }),
});
export type FkDeclaration = z.infer<typeof fkDeclarationSchema>;

export const fkIdentitySchema = z.object({
  schemaVersion: z.literal(fkContractVersion),
  jobId: z.string().uuid(),
  episode: z.number().int().nonnegative(),
  profileHash: sha256,
  jointUnit: z.enum(["rad", "deg"]),
  representation: z.literal("absolute_joint_position"),
  convention: z.object({
    kind: z.literal("nominal_sign_zero"),
    nominalSignZeroConfirmed: z.literal(true),
    source: z.literal("user_declared"),
  }),
  generation: z.number().int().nonnegative(),
});

const jointMappingSchema = z.object({
  jointName: nonEmpty,
  channelName: nonEmpty,
  sourceIndex: z.number().int().nonnegative(),
});
const rawFrameSchema = z.object({
  frame: z.number().int().nonnegative(),
  predicted: z.array(finite).length(16),
  target: z.array(finite).length(16),
});

const sourceChannelsShape = {
  actionNames: z.array(nonEmpty).length(16),
  jointMapping: z.array(jointMappingSchema).length(14),
};
function validateSourceChannels(
  source: { readonly actionNames: readonly string[]; readonly jointMapping: readonly z.infer<typeof jointMappingSchema>[] },
  context: z.RefinementCtx,
) {
  const mappings = source.jointMapping;
  const jointNames = mappings.map((mapping) => mapping.jointName);
  const channelNames = mappings.map((mapping) => mapping.channelName);
  const sourceIndices = mappings.map((mapping) => mapping.sourceIndex);
  const unique = (values: readonly (string | number)[]) => new Set(values).size === values.length;
  if (!unique(source.actionNames) || !unique(jointNames) || !unique(channelNames) || !unique(sourceIndices)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["jointMapping"], message: "Joint mappings must be unique by joint, channel, and source index" });
  }
  const requiredNames = [...armJointNames.right, ...armJointNames.left];
  if (requiredNames.some((name) => !jointNames.includes(name)) ||
      requiredNames.some((name) => !channelNames.includes(name)) ||
      !source.actionNames.includes("right_gripper_0") || !source.actionNames.includes("left_gripper_0") ||
      mappings.some((mapping) => mapping.jointName !== mapping.channelName ||
        source.actionNames[mapping.sourceIndex] !== mapping.channelName)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["jointMapping"], message: "Joint mappings must name all seven joints on both arms" });
  }
}
export const fkRequestSchema = fkIdentitySchema.extend({
  profile: compiledProfileSchema,
  ...sourceChannelsShape,
  frames: z.array(rawFrameSchema),
}).superRefine((request, context) => {
  validateSourceChannels(request, context);
  if (request.profileHash !== request.profile.profileHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["profileHash"], message: "Request profile hash does not match compiled profile" });
  }
});
export type FkRequest = z.infer<typeof fkRequestSchema>;

const quaternionXyzwSchema = z.tuple([finite, finite, finite, finite]).superRefine(
  ([x, y, zValue, w], context) => {
    if (Math.abs(Math.hypot(x, y, zValue, w) - 1) > 1e-6) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Quaternion must have unit length" });
    }
  },
);
const displayRpySchema = z.tuple([finite.nullable(), finite.nullable(), finite.nullable()]);
const derivedPoseSchema = z.object({
  translationM: vector3.nullable(),
  quaternionXyzw: quaternionXyzwSchema.nullable(),
  rpyDeg: displayRpySchema,
});
const armErrorsSchema = z.object({
  translationM: finite.nonnegative().nullable(),
  orientationRad: finite.nonnegative().max(Math.PI).nullable(),
});
const armDerivationSchema = z.object({
  pose: z.object({
    predicted: derivedPoseSchema,
    target: derivedPoseSchema,
  }),
  errors: armErrorsSchema,
  valid: z.boolean(),
  reasons: z.array(nonEmpty),
}).superRefine((arm, context) => {
  const hasPairedPoses = [arm.pose.predicted, arm.pose.target].every(
    (pose) => pose.translationM !== null && pose.quaternionXyzw !== null,
  );
  const hasPairedErrors = arm.errors.translationM !== null && arm.errors.orientationRad !== null;
  if (arm.valid && (!hasPairedPoses || !hasPairedErrors)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A valid arm derivation requires both poses and both errors",
    });
  }
  if (!arm.valid && arm.reasons.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "An unavailable arm derivation requires a reason",
    });
  }
});
const summaryMetricSchema = z.object({
  mean: finite.nonnegative().nullable(),
  rms: finite.nonnegative().nullable(),
  count: z.number().int().nonnegative(),
}).superRefine((metric, context) => {
  if (metric.count === 0 ? metric.mean !== null || metric.rms !== null : metric.mean === null || metric.rms === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Summary mean and RMS must be null exactly when count is zero",
    });
  }
});
const armSummarySchema = z.object({
  translationM: summaryMetricSchema,
  orientationRad: summaryMetricSchema,
});
const profileProvenanceSchema = z.object({
  model: nonEmpty,
  revision: nonEmpty,
  urdfSha256: sha256,
  rootLink: z.literal("link_torso_5"),
  tips: z.object({ right: z.literal("ee_right"), left: z.literal("ee_left") }),
});
const derivedFrameSchema = z.object({
  frame: z.number().int().nonnegative(),
  source: z.object({
    predicted: z.array(finite).length(16),
    target: z.array(finite).length(16),
  }),
  arms: z.object({
    right: armDerivationSchema,
    left: armDerivationSchema,
  }),
});

export const fkResultSchema = fkIdentitySchema.extend({
  profile: profileProvenanceSchema,
  ...sourceChannelsShape,
  samples: z.array(derivedFrameSchema),
  summaries: z.object({
    right: armSummarySchema,
    left: armSummarySchema,
  }),
}).superRefine(validateSourceChannels);
export type FkResult = z.infer<typeof fkResultSchema>;
