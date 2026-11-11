import type { CompiledProfile } from "../../kinematics/contracts";
import { Field } from "../ui/primitives";
import { matchingColumns } from "./prediction-settings";
import type { PredictionSettingsValue } from "./prediction-settings";

export function PredictionSettings(props: {
  readonly value: PredictionSettingsValue;
  readonly actionNames: readonly string[];
  readonly profiles: readonly Omit<CompiledProfile, "leftChain" | "rightChain">[];
  readonly profile: CompiledProfile | null;
  readonly observationCount: number;
  readonly loading: boolean;
  readonly error: string;
  readonly onChange: (value: PredictionSettingsValue) => void;
  readonly onApply: () => void;
}) {
  const { value, onChange } = props;
  const update = (patch: Partial<PredictionSettingsValue>) => onChange({ ...value, ...patch });
  const axes = value.kind === "cartesian"
    ? ["x", "y", "z", ...(value.orientation === "quaternion_xyzw" ? ["qx", "qy", "qz", "qw"] : ["rx", "ry", "rz"])]
    : Array.from({ length: 7 }, (_, index) => `J${index}`);
  const options = props.actionNames.map((name, index) => <option key={index} value={index}>{index} · {name}</option>);
  return <section className="prediction-settings" aria-label="Prediction source settings">
    <div className="prediction-settings__fields">
      <Field label="데이터 원본 형식"><select data-source-kind value={value.kind} onChange={(event) => {
        const kind = event.currentTarget.value;
        if (kind === "joint" || kind === "cartesian" || kind === "unknown")
          update({ kind, ...matchingColumns(props.actionNames, kind, value.orientation), confirmed: false });
      }}><option value="unknown">형식 선택</option><option value="joint">Joint</option><option value="cartesian">Cartesian</option></select></Field>
      <Field label="기록된 액션 의미"><select data-source-representation value={value.representation} onChange={(event) => {
        const representation = event.currentTarget.value;
        if (representation === "absolute" || representation === "delta" || representation === "velocity" || representation === "unknown") update({ representation });
      }}><option value="unknown">미확인</option><option value="absolute">절대 위치 / 자세</option><option value="delta">변위 (변환 불가)</option><option value="velocity">속도 (변환 불가)</option></select></Field>
      {value.kind === "joint" && <Field label="원본 관절 단위"><select data-source-joint-unit value={value.unit} onChange={(event) => {
        const unit = event.currentTarget.value;
        if (unit === "rad" || unit === "deg" || unit === "unknown") update({ unit });
      }}><option value="unknown">단위 미확인</option><option value="rad">rad</option><option value="deg">deg</option></select></Field>}
      {value.kind === "cartesian" && <>
        <Field label="원본 위치 단위"><select data-source-position-unit value={value.positionUnit} onChange={(event) => {
          const positionUnit = event.currentTarget.value;
          if (positionUnit === "" || positionUnit === "m" || positionUnit === "mm") update({ positionUnit });
        }}><option value="">단위 선택</option><option value="m">m</option><option value="mm">mm</option></select></Field>
        <Field label="원본 회전 표현"><select data-source-orientation value={value.orientation} onChange={(event) => {
          const orientation = event.currentTarget.value;
          if (orientation === "" || orientation === "rpy_xyz" || orientation === "quaternion_xyzw")
            update({ orientation, ...matchingColumns(props.actionNames, value.kind, orientation) });
        }}><option value="">표현 선택</option><option value="rpy_xyz">고정축 XYZ RPY · RzRyRx</option><option value="quaternion_xyzw">Quaternion · x,y,z,w</option></select></Field>
        {value.orientation === "rpy_xyz" && <Field label="원본 회전 단위"><select data-source-angle-unit value={value.angleUnit} onChange={(event) => {
          const angleUnit = event.currentTarget.value;
          if (angleUnit === "" || angleUnit === "rad" || angleUnit === "deg") update({ angleUnit });
        }}><option value="">단위 선택</option><option value="rad">rad</option><option value="deg">deg</option></select></Field>}
        <Field label="Cartesian 기준 프레임"><select data-source-reference value={value.referenceFrame} onChange={(event) => update({ referenceFrame: event.currentTarget.value })}>
          <option value="unknown">미확인 (IK 불가)</option><option value="link_torso_5">어깨 · link_torso_5</option>
          <option value="base">Base (IK 전 기준 변환 필요)</option><option value="world">World (IK 전 기준 변환 필요)</option>
        </select></Field>
      </>}
    </div>
    <details className="prediction-mapping" open={[...value.left, ...value.right].some((column) => column === null)}>
      <summary>원본 채널 연결 · 열 번호와 이름 확인</summary>
      <div className="prediction-mapping__arms">{(["left", "right"] as const).map((side) => <fieldset key={side}>
        <legend>{side === "left" ? "Left" : "Right"}</legend>
        <div className="prediction-settings__fields">{axes.map((axis, index) => <Field key={axis} label={axis}>
          <select data-map={`${side}-${index}`} value={value[side][index] ?? ""} onChange={(event) => update({
            [side]: value[side].map((column, i) => i === index ? event.currentTarget.value === "" ? null : Number(event.currentTarget.value) : column),
          })}><option value="">채널 선택</option>{options}</select>
        </Field>)}
          <Field label="Gripper"><select data-map={`${side}-gripper`} value={side === "left" ? value.leftGripper ?? "" : value.rightGripper ?? ""}
            onChange={(event) => update({ [side === "left" ? "leftGripper" : "rightGripper"]: event.currentTarget.value === "" ? null : Number(event.currentTarget.value) })}>
            <option value="">그리퍼 채널 없음</option>{options}
          </select></Field>
        </div>
      </fieldset>)}</div>
    </details>
    <div className="prediction-settings__fields">
      <Field label="변환용 로봇 프로필" hint="원본 좌표 보기에는 필요하지 않습니다."><select data-prediction-profile value={value.profileHash} disabled={props.loading}
        onChange={(event) => update({ profileHash: event.currentTarget.value, confirmed: false })}>
        <option value="">변환 사용 안 함</option>
        {props.profiles.map((profile) => <option key={profile.profileHash} value={profile.profileHash}>{profile.model} · {profile.revision}</option>)}
      </select></Field>
      <label className="fk-check"><input data-prediction-confirm type="checkbox" checked={value.confirmed} disabled={!props.profile}
        onChange={(event) => update({ confirmed: event.currentTarget.checked })} />기록 관절값 / IK 초기값의 방향·영점이 선택한 모델과 일치함을 확인합니다.</label>
    </div>
    {value.kind === "cartesian" && <fieldset className="prediction-seed">
      <legend>IK 초기 관절 상태 · 원래 관절값의 복원이 아닌 파생 해입니다</legend>
      <div className="prediction-settings__fields">
        <Field label="IK 초기값 출처"><select data-ik-seed-kind value={value.seedKind} onChange={(event) => {
          const seedKind = event.currentTarget.value;
          if (seedKind === "manual" || seedKind === "observed") update({ seedKind });
        }}><option value="observed">관측 Joint ({props.observationCount} 프레임)</option><option value="manual">직접 지정</option></select></Field>
        <Field label="초기 관절 단위"><select data-ik-seed-unit value={value.seedUnit} onChange={(event) => {
          const seedUnit = event.currentTarget.value;
          if (seedUnit === "" || seedUnit === "rad" || seedUnit === "deg") update({ seedUnit });
        }}><option value="">단위 선택</option><option value="rad">rad</option><option value="deg">deg</option></select></Field>
        {value.seedKind === "manual" && <>
          <Field label="Left 초기값 · J0…J6" hint="7개 값을 공백이나 쉼표로 구분"><input data-ik-seed-left value={value.leftSeed} onChange={(event) => update({ leftSeed: event.currentTarget.value })} /></Field>
          <Field label="Right 초기값 · J0…J6" hint="7개 값을 공백이나 쉼표로 구분"><input data-ik-seed-right value={value.rightSeed} onChange={(event) => update({ rightSeed: event.currentTarget.value })} /></Field>
        </>}
      </div>
      <p className="muted">관절 제한 안에서 이전 해를 이어 풉니다. 초기값 없음·수렴 실패는 빈 구간으로 표시합니다. 새 평가는 이름이 확인된 관측 관절 상태를 함께 저장합니다.</p>
    </fieldset>}
    {props.profile && <p className="muted path">{props.profile.rootLink} → {props.profile.tips.left} / {props.profile.tips.right} · {props.profile.profileHash}</p>}
    {props.error && <p role="status" className="notice">{props.error}</p>}
    <button type="button" data-apply-prediction disabled={props.loading} onClick={props.onApply}>원본 / 변환 설정 적용</button>
  </section>;
}
