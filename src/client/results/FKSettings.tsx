import { useId } from "react";
import { fkRequestSchema, type CompiledProfile, type FkRequest } from "../../kinematics/contracts";
import "./fk.css";

export type FKSettingsValue = {
  readonly enabled: boolean;
  readonly profileHash: string;
  readonly jointUnit: "" | "rad" | "deg";
  readonly representation: "" | "absolute_joint_position" | "delta" | "velocity" | "unknown";
  readonly nominalSignZeroConfirmed: boolean;
};
export const initialFKSettings: FKSettingsValue = {
  enabled: false, profileHash: "", jointUnit: "", representation: "", nominalSignZeroConfirmed: false,
};
export type FKProfileMetadata = Omit<CompiledProfile, "rightChain" | "leftChain">;
export type FKSettingsProps = {
  readonly value: FKSettingsValue;
  readonly profiles: readonly FKProfileMetadata[];
  readonly onChange: (value: FKSettingsValue) => void;
  readonly notice?: string;
  readonly loading?: boolean;
};

/** Parent owns catalog fetching, invalidation and the production Worker controller. */
export function declaredFKRequest(value: FKSettingsValue, profile: unknown,
  source: Pick<FkRequest, "jobId" | "episode" | "actionNames" | "jointMapping" | "frames">,
): { readonly kind: "ready"; readonly request: Omit<FkRequest, "generation"> }
  | { readonly kind: "unavailable"; readonly reason: string } {
  if (!value.enabled) return { kind: "unavailable", reason: "FK is off. Raw joint analysis remains available." };
  if (!value.profileHash || !value.jointUnit || value.representation !== "absolute_joint_position" || !value.nominalSignZeroConfirmed) {
    return { kind: "unavailable", reason: "Select a profile, declare rad or deg and absolute joint positions, and confirm nominal sign/zero agreement." };
  }
  const parsed = fkRequestSchema.safeParse({
    ...source, schemaVersion: 1, generation: 0, profile, profileHash: value.profileHash,
    jointUnit: value.jointUnit, representation: value.representation,
    convention: { kind: "nominal_sign_zero", nominalSignZeroConfirmed: true, source: "user_declared" },
  });
  if (!parsed.success) return { kind: "unavailable", reason: `FK unavailable: ${parsed.error.issues.map((issue) => issue.message).join("; ")}. Raw joint analysis remains available.` };
  const { generation: _generation, ...request } = parsed.data;
  return { kind: "ready", request };
}

export function FKSettings({ value, profiles, onChange, notice, loading = false }: FKSettingsProps) {
  const id = useId();
  const profile = profiles.find((item) => item.profileHash === value.profileHash);
  return <section className="fk-settings" aria-label="FK settings">
    <header><h2>Optional derived pose</h2><p>Off by default. Declare recorded action semantics; no model or unit is inferred.</p></header>
    <label className="fk-check"><input type="checkbox" data-fk-enable checked={value.enabled}
      onChange={(event) => onChange({ ...value, enabled: event.currentTarget.checked })} />Enable FK analysis</label>
    <div className="fk-settings__fields">
      <label htmlFor={`${id}-profile`}>Existing profile<select id={`${id}-profile`} data-fk-profile value={value.profileHash}
        disabled={!value.enabled || loading} onChange={(event) => onChange({ ...value, profileHash: event.currentTarget.value, nominalSignZeroConfirmed: false })}>
        <option value="">Select an existing profile</option>
        {profiles.map((item) => <option key={item.profileHash} value={item.profileHash}>{item.model} · {item.revision} · {item.profileHash.slice(0, 12)}</option>)}
      </select></label>
      <label htmlFor={`${id}-unit`}>Source joint unit<select id={`${id}-unit`} data-fk-unit value={value.jointUnit}
        disabled={!value.enabled} onChange={(event) => {
          const jointUnit = event.currentTarget.value;
          if (jointUnit === "" || jointUnit === "rad" || jointUnit === "deg") onChange({ ...value, jointUnit });
        }}><option value="">Declare units</option><option value="rad">rad</option><option value="deg">deg</option></select></label>
      <label htmlFor={`${id}-representation`}>Recorded representation<select id={`${id}-representation`} data-fk-representation
        disabled={!value.enabled} value={value.representation} onChange={(event) => {
          const representation = event.currentTarget.value;
          if (representation === "" || representation === "absolute_joint_position" || representation === "delta" || representation === "velocity" || representation === "unknown") onChange({ ...value, representation });
        }}><option value="">Declare representation</option><option value="absolute_joint_position">Absolute joint position</option>
        <option value="delta">Delta (unavailable)</option><option value="velocity">Velocity (unavailable)</option><option value="unknown">Unknown (unavailable)</option></select></label>
    </div>
    <label className="fk-check"><input type="checkbox" data-fk-confirm disabled={!value.enabled || !profile}
      checked={value.nominalSignZeroConfirmed} onChange={(event) => onChange({ ...value, nominalSignZeroConfirmed: event.currentTarget.checked })} />
      I confirm recorded joint signs and zeros match this profile's nominal convention.</label>
    <p>User-declared provenance, not automatically verified calibration.</p>
    {profile && <dl className="fk-provenance">
      <div><dt>Model / revision</dt><dd>{profile.model} / {profile.revision}</dd></div>
      <div><dt>URDF SHA256</dt><dd>{profile.urdfSha256}</dd></div>
      <div><dt>Profile digest</dt><dd>{profile.profileHash}</dd></div>
      <div><dt>Shoulder root / tips</dt><dd>{profile.rootLink} → {profile.tips.right} / {profile.tips.left}</dd></div>
      <div><dt>Local source</dt><dd>{profile.sourcePath}</dd></div>
    </dl>}
    {(loading || notice || profiles.length === 0) && <p role="status">{loading ? "Loading local profiles…" : notice || "No compatible local profiles. Raw joint analysis remains available."}</p>}
  </section>;
}
