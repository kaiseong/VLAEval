# VLAEval

OpenPi 모델을 로봇 없이 평가하는 로컬 웹 앱입니다. RTX6000에 이미 준비된
config, 체크포인트, LeRobot 데이터셋을 선택하고, 지정한 episode의 관측으로
action을 추론하여 정답 action과 비교합니다.

**파일 업로드, 학습, config 편집, 로봇 제어는 제공하지 않습니다.**
모델과 데이터는 사용자가 추론 PC에 미리 준비해야 합니다.

## 실행

```bash
cd /home/kgs/workspace/VLA/VLAEval
bun install
bun run start
```

브라우저에서 <http://127.0.0.1:4310>을 엽니다. 개발 시에는 `bun run dev`를
사용합니다. 다른 포트는 `PORT=4311 bun run start`로 지정할 수 있습니다.
서버는 로컬 루프백 주소에만 바인딩합니다.

선택적 환경 변수:

- `VLAEVAL_RUNS_DIR`: 실행 기록 저장 위치를 바꿀 때 쓰는 절대 디렉터리 경로입니다.
  지정하지 않으면 `.runs/`를 씁니다.
- `VLAEVAL_URDF_ROOTS`: 선택 FK가 읽을 URDF 디렉터리의 JSON 배열입니다. 모두 절대
  경로여야 합니다. 예: `VLAEVAL_URDF_ROOTS='["/data/rby1a/urdf"]' bun run start`.
  지정하지 않으면 존재하는 경우에 한해 다음 두 곳을 읽습니다.
  `/home/kgs/workspace/sdk-tools/rby1-pose-studio/assets/models/rby1a/urdf`,
  `/home/kgs/workspace/sdk-tools/rby1-pose-studio/assets/models/rby1m/urdf`.
  `[]`을 주면 FK만 꺼지고 나머지 분석은 그대로 동작합니다.

로컬 PC의 SSH 키 또는 SSH agent로 다음 명령이 대화형 비밀번호 입력 없이
동작해야 합니다.

```bash
ssh -o BatchMode=yes rtx6000@192.168.0.3 true
```

새 서버의 호스트 키 등록이나 비밀번호 인증 설정은 터미널에서 먼저 처리하세요.
앱은 비밀번호와 SSH 개인 키를 저장하지 않으며, 호스트 키 검증을 끄지 않습니다.

## 평가 순서

1. **추론 PC와 탐색 경로**를 확인하고 기존 파일을 탐색합니다. 모델이 NAS나 다른
   디스크에 있다면 해당 PC에서 보이는 절대 경로를 탐색 목록에 추가합니다.
2. **OpenPi 저장소와 config**를 선택합니다. 저장소의 `.venv/bin/python` 환경에서
   실제 등록된 config 목록을 가져옵니다. 로컬 OpenPi 복사본의 설정을 대신 쓰지 않습니다.
3. **체크포인트와 데이터셋**을 선택합니다. 탐색 범위 밖의 항목은 절대 경로로
   직접 지정할 수 있습니다. 자동 탐색은 후보 발견이며, 파일명만 보고 모델과
   config의 호환성을 보장하지 않습니다.
4. 데이터셋의 **episode 목록을 불러와 평가할 episode를 명시적으로 선택**합니다.
   기본값은 stride 1, 프레임 제한 0으로 선택한 episode 전체를 평가합니다.
   빠른 점검이 필요하면 stride 또는 최대 프레임 수를 변경합니다.
5. 평가를 실행하고 진행률과 로그를 확인합니다. **취소**는 원격 worker에 종료 신호를
   보내며, worker 종료가 확인되기 전에는 완료된 것으로 표시하지 않습니다.
6. 상단 **결과 분석** 탭에서 저장된 실행을 엽니다. 완료된 실행은 로컬 `.runs/`에
   저장되며, 같은 화면에서 다시 열 수 있습니다. 아래 "결과 분석 화면"을 참고하세요.

처음 모델을 로딩하거나 JAX를 컴파일할 때는 진행률이 잠시 움직이지 않을 수 있습니다.
단일 GPU에서 중복 모델 로딩을 피하기 위해 앱은 평가를 한 번에 하나만 실행합니다.

## 결과 분석 화면

결과 화면 상단에는 config, 평가 프레임 수, FPS, 결과 에피소드 선택, 원본 내보내기
버튼이 있습니다. 그 아래 coverage 줄과 run 전체 점수 다섯 개(첫 스텝 MAE/RMSE,
전체 청크 MAE/RMSE, Valid horizon rows)가 나오고, 다섯 개의 보기 탭이 이어집니다.

- **Overview**: 모든 action 채널을 한 화면에 그립니다. RBY1 16차원 결과는 1440px
  폭에서 4열 4행으로, 오른팔이 1, 2열, 왼팔이 3, 4열입니다(J0/J1, J2/J3, J4/J5,
  J6/gripper). 이름이 맞지 않는 다른 로봇의 차원도 숨기지 않고 일반 패널로 보입니다.
  760px 이하에서는 2열로 바뀌고 세로로 스크롤합니다. 예측은 실선, 정답은 점선입니다.
- **공통 커서와 구간**: Overview와 Optional FK 탭의 `Source frame`, `Window start`,
  `Window end`가 모든 패널을 같은 원본 프레임과 같은 구간으로 묶습니다. 시간은
  `원본 프레임 / FPS`로 계산합니다. 에피소드나 실행을 바꾸면 커서와 구간이 처음으로
  돌아갑니다.
- **Detail**: 패널을 누르면 같은 커서와 구간으로 한 채널을 크게 봅니다. `Close detail`
  또는 Esc로 닫으면 포커스가 열었던 패널로 돌아갑니다.
- **Future chunks**: 저장된 chunk 예시를 `episode / origin / horizon`으로 고릅니다.
  가로축은 `(origin + horizon) / FPS`입니다. 이 선택은 Overview 커서와 별개입니다.
  고른 origin이 저장된 예시에 없으면 다른 예시로 대신하지 않고 없다고 표시합니다.
- **Metrics**: 세 개 표의 범위가 다릅니다. 에피소드 표(`에피소드별 오차 · 첫 action 기준`)는
  episode마다 첫 스텝만 모은 값이고, 차원 표와 horizon 표(`…전체 청크 오차`)는 run
  전체 chunk의 유효 행을 모은 값입니다.
- **Optional FK**: 기본은 꺼져 있습니다. 아래 "선택 FK" 절을 참고하세요.
- **Metadata & warnings**: host, 저장소, 체크포인트, 데이터셋, episode, seed, 추론
  step 수, stride, 최대 프레임 수, 지연 시간 중앙값과 p95, worker 경고를 담습니다.

## 프레임과 horizon coverage

기본값 `stride=1`, `maxSamples=0`은 선택한 각 episode의 모든 관측 프레임
`t=0..N-1`을 따로 추론합니다. 여기서 N은 채점한 anchor 수입니다. 첫 추론 전에
warmup 호출이 한 번 더 있으므로 비어 있지 않은 실행의 정책 호출은 N+1번이고,
warmup은 진행률, coverage, 점수, 지연 시간에서 모두 빠집니다.

chunk 길이 H에서 미래 정답이 끝까지 남은 anchor는 `t=N-H`까지이며(0부터 셈,
포함), 개수는 `max(N-H+1, 0)`입니다. 그 뒤의 anchor도 버리지 않습니다. 첫 스텝
그래프에 그대로 남고, chunk 점수에서는 episode 안에 실제로 남은 미래 행만 채점하는
**partial tail**이 됩니다. 반복된 padding 정답은 세지 않고, 다음 episode의 프레임을
빌려 오지도 않습니다. 추가 padding이 없을 때 horizon h의 유효 행은 `max(N-h, 0)`개입니다.

| N / H | 추론 anchor | 온전한 horizon | partial tail | 유효 미래 행 |
|---|---|---|---|---|
| 100 / 40 | 100 | 61 | 39 | 3220 |
| 40 / 40 | 40 | 1 | 39 | 820 |
| 10 / 40 | 10 | 0 | 10 | 55 |
| 1 / 40 | 1 | 0 | 1 | 1 |

결과 상단의 coverage 줄은 두 범위를 나눠 보여 줍니다.

- `First-step · EP n`: 채점 anchor 수 / 원본 프레임 수, 마지막 채점 프레임,
  `warm-up excluded`.
- `Future chunks · EP n`: H, geometric full / tail anchor 수, 완전히 유효한 chunk 수,
  유효 행 수. 데이터셋 padding mask가 중간에 참인 chunk는 geometric full이어도
  "완전히 유효"에 들어가지 않으므로 두 숫자가 다를 수 있습니다.
- stride가 1이 아니거나 `maxSamples`가 0이 아니면 `Quick subset` 표시가 붙습니다.

**이전 결과(legacy)**: coverage 기록 전에 저장된 실행도 그대로 열립니다. 이때 원본
프레임 수, padding mask, full/tail 개수, episode별 유효 행은 `unknown`으로 표시합니다.
마지막 샘플 프레임으로 길이를 짐작하지 않습니다. 정확한 coverage가 필요하면 같은
설정으로 다시 평가하세요. 기존 점수와 원본 JSON/CSV 값은 다시 쓰지 않습니다.

## 지표 해석

- **첫 스텝(first-step) 지표**: 각 관측 프레임에서 예측한 chunk의 첫 action과 같은
  프레임의 정답 action을 비교합니다. Overview 패널 머리의 MAE/RMSE는 선택한
  episode의 채점된 전체 첫 스텝 trace에서 계산하며(이전 결과나 Quick subset에서는
  채점한 프레임만), 확대 구간이나 화면에 그리는 점
  수를 바꿔도 변하지 않습니다. 로봇 실행이나 async action aggregation을 재현한
  closed-loop rollout이 아닙니다.
- **청크(chunk) 지표**: 예측 chunk와 정답 미래 action 시퀀스의 run 단위 오차입니다.
  partial tail은 남은 유효 행만 들어가고 padding은 빠집니다. 차원별 chunk 지표는
  첫 스텝 패널 점수와 다른 값이며, 서로 대신 쓰지 않습니다.
- **episode별 지표**: 각 episode의 첫 스텝 오차입니다. worker는 추론마다 첫 행만
  (`predicted[:1]`, `target[:1]`) 해당 episode 지표에 더합니다. chunk 오차가 아닙니다.
- **차원별 / horizon별 지표**: run 전체 chunk의 유효 행으로 계산합니다. 특정 관절 또는
  먼 미래 시점에서 오차가 커지는지 구분합니다. horizon별 유효 표본 수도 함께 확인하세요.
- **단위**: 결과 파일에는 물리 단위가 기록되지 않으므로 그래프 축은
  `native / unknown`으로 표시합니다. gripper는 팔 관절과 묶어 요약하지 않습니다.
- **값이 없음**: 계산할 수 없는 값은 0으로 채우지 않고 비워 두거나 사용할 수 없다고
  표시합니다.
- **추론 시간**: warmup을 제외한 관측 입력부터 실제 출력 배열 획득까지의 시간입니다.
  모델 로딩, 데이터 영상 읽기, SSH 왕복 시간과는 구분됩니다.

## 내보내기

원본 내보내기와 FK 파생 내보내기는 서로 다른 파일입니다.

- `결과 JSON` → `vlaeval-<jobId>.json`: 저장된 결과를 그대로 씁니다.
- `전체 trace CSV` → `vlaeval-<jobId>.csv`: 열은
  `episode,frame,time_seconds,dimension,action,predicted,target,error`이며 저장된 모든
  첫 스텝 프레임과 차원을 한 번씩 씁니다. 화면용으로 줄인 점이 아닙니다.
- `Derived FK JSON` / `Derived FK CSV` → `vlaeval-<jobId>-ep<n>.fk.json` / `.fk.csv`:
  지금 선택과 정확히 일치하는 FK 계산이 끝났을 때만 활성화됩니다. job, episode,
  원본 프레임 ID, profile digest, URDF SHA256, 모델/리비전, root/tip, 선언한 단위와
  표현, 부호/영점 확인, 팔별 유효 쌍 개수를 함께 담습니다. 위치는 m, 자세는
  quaternion xyzw, 자세 오차는 rad입니다.

## 선택 FK (어깨 기준 자세)

FK는 관절 분석을 대체하지 않는 선택 기능이며 기본값은 꺼짐입니다. `Optional FK`
탭에서 다음을 모두 해야 계산이 시작됩니다.

1. `Enable FK analysis`를 켭니다.
2. 로컬 URDF 디렉터리에서 찾은 기존 profile을 고릅니다. 기본 디렉터리에서는 네 개가
   나옵니다: `RBY1_A v1.1`, `RBY1_A v1.2`, `RBY1_M v1.1`, `RBY1_M v1.2`. 화면에 모델,
   리비전, URDF SHA256, profile digest, root/tip, 원본 경로가 보입니다. 체인을 만들 수
   없는 파일(예: `model.urdf`, v1.0, `RBY1_M v1.3`)은 목록에서 빠집니다.
3. 기록된 관절 단위를 `rad` 또는 `deg`로 직접 선언합니다. 단위는 추정하지 않습니다.
4. 기록 표현을 `Absolute joint position`으로 선언합니다. `Delta`, `Velocity`,
   `Unknown`을 고르면 FK만 비활성화됩니다.
5. 기록된 관절의 부호와 영점이 그 profile의 공칭(nominal) 규약과 같다고 확인합니다.
   이 확인은 사용자가 선언한 출처 정보이며, 앱이 보정을 검증한 것은 아닙니다.

계산 범위와 한계:

- 체인은 `link_torso_5`(어깨 쪽 몸통 링크)에서 `ee_right` / `ee_left`까지이며
  `tool_right` / `tool_left` 고정 오프셋을 포함합니다. 팔마다 이름이 정해진 회전 관절
  일곱 개만 씁니다. gripper와 torso 관절은 들어가지 않습니다.
- 결과는 **어깨 기준 상대 자세**입니다. 로봇 base, world, TCP 좌표를 주장하지
  않습니다. torso 상태와 보정 정보가 결과에 없기 때문입니다.
- 팔마다 x/y/z(mm)와 roll/pitch/yaw(deg, `R=Rz(yaw)Ry(pitch)Rx(roll)`) 패널을
  보여 줍니다. pitch가 ±90°에 가까우면(`|cos(pitch)| < 1e-6`) roll/yaw는 사용할 수
  없다고 표시하지만 위치 오차와 SO(3) 각도 오차는 유효합니다. ±180° 경계에서는 선을
  잇지 않습니다.
- 오차는 위치 유클리드 거리와 SO(3) geodesic 각도를 따로 계산하고 따로 셉니다.
  둘을 섞은 단일 점수는 없습니다.
- 관절에서 자세로 가는 변환은 다대일입니다. 서로 다른 관절 값이 같은 자세가 될 수
  있으므로 자세 오차가 작다고 관절 예측이 맞았다는 뜻은 아닙니다.
- 계산은 브라우저 Worker에서 화면용으로 줄이기 전의 채점된 첫 스텝 trace 전체로 합니다. profile, 단위, 선언,
  episode를 바꾸면 이전 계산은 무효가 되고, 늦게 끝난 이전 결과는 화면과 내보내기에
  쓰이지 않습니다.
- profile 디렉터리가 없거나 맞는 profile이 없으면 `No compatible local profiles.
  Raw joint analysis remains available.`가 나오고 FK만 꺼집니다. URDF 업로드, 메시 가져오기,
  로봇 접속은 하지 않습니다. 로컬 읽기 전용 API는 `GET /api/kinematics/profiles`와
  `GET /api/kinematics/profiles/<64자리 digest>`이며, 루트 밖 경로, 2 MiB 초과,
  DTD/entity가 있는 XML, 읽은 뒤 바뀐 파일은 거부합니다.

평가에는 체크포인트에 저장된 정규화 통계와 선택한 config의 입력/출력 변환을
사용합니다. RBY1의 관절 delta 출력은 절대 action으로 복원한 뒤 비교합니다.
관절과 gripper의 단위가 다를 수 있으므로 전체 평균만으로 판단하지 말고 차원별
지표를 함께 보세요.

## 과학적 한계

- 오프라인 action 오차는 실제 로봇의 작업 성공률이 아닙니다. 로봇 제어, closed-loop
  rollout, 실시간 성능을 측정하지 않습니다.
- 학습에 사용한 episode라면 일반화 성능이 아니라 학습 데이터 재현 성능입니다.
- 몇 프레임만 돌린 빠른 점검이나 `Quick subset` 결과는 모델 전체 성능이 아닙니다.
- FK 결과는 선언한 단위, 표현, 부호/영점 규약이 맞을 때만 의미가 있습니다. 어깨 기준
  상대 자세이며 base, world, TCP 위치나 실제 로봇 자세가 아닙니다.
- FK 체인 자체는 설치된 `rby1-sdk` 0.10.0과 오프라인으로 대조했습니다. 제공하는 네
  geometry에서 절대 자세 376개를 비교했고 최대 차이는 약 9.4e-10 m, 1.5e-9 rad였습니다.
  이는 URDF 기하 계산이 SDK와 일치한다는 뜻일 뿐, 로봇 보정이나 실제 자세 정확도를
  보증하지 않습니다.
- 이전 결과의 coverage는 알 수 없으며 추정하지 않습니다.

## 구조

```text
브라우저 ── 로컬 Bun 서버 ── SSH ── RTX6000 Python/OpenPi
                 │                      │
              .runs/               기존 모델·데이터
```

- `src/client/`: 선택 UI, 진행 상태, 결과 그래프.
- `src/api.ts`, `src/jobs.ts`: API, SSE, 단일 평가 실행, 결과 저장.
- `src/remote.ts`: 검증된 인수로 SSH 실행 및 worker 이벤트 수신.
- `worker.py`: 기존 파일 탐색, config/episode 조회, OpenPi 추론과 오차 계산.
- `src/client/results/`, `src/client/analysis/`, `src/client/charts/`: 결과 작업 공간,
  첫 스텝 통계, 내보내기, FK Worker 제어, 그래프.
- `src/kinematics/`: 로컬 URDF profile 목록, 체인 컴파일, FK 계약.
- `tests/`: 작업 생명주기와 평가 계산의 회귀 테스트, `tests/e2e/qa.mjs` 브라우저 QA.

worker 소스는 SSH 표준입력으로 전달합니다. 추론 PC 저장소에 코드를 배포하거나
기존 모델·데이터를 수정하지 않습니다. 모델 라이브러리 자체가 사용하는 런타임
캐시는 기존 OpenPi 환경의 설정을 따릅니다. 앱은 원격 패키지를 자동 설치하지 않습니다.

평가기는 LeRobot v2 계열 데이터 API와 v3 parquet/영상 메타데이터 읽기를 지원합니다.
v3 데이터는 추론 PC의 OpenPi 환경에 설치된 parquet·영상 라이브러리로 읽으며,
v2로 변환하거나 원본을 다시 저장하지 않습니다.
지원하지 않는 데이터 형식이나 맞지 않는 action shape은 오류로 표시하며,
임의로 잘라서 평가 성공으로 처리하지 않습니다.

## 검증 명령

```bash
bun run typecheck
bun test
bun run build
/home/kgs/workspace/VLA/pi05_rby1/.venv/bin/python -m pytest tests/test_worker.py
```

Python 테스트 환경에는 `pytest`와 `numpy`가 필요합니다. 실제 평가 실행 환경에는
해당 OpenPi 저장소의 기존 의존성과 GPU 실행 환경이 필요합니다.

## 실제 연결 검증 기록

2026-10-04에 다음 경로를 확인했습니다.

- 추론 PC: `rtx6000@192.168.0.3`
- OpenPi: `/home/rtx6000/kgs/pi05_rby1`, revision `574a4b789c32d58d967b7784f9fe55dbf051197f`
- 실제 config 37개, 체크포인트 7개 탐색
- `flowers_sorting_mirrored` v3.0 데이터셋의 episode 478개 조회 및 UI 선택
- `pi05_rby1_flower_0626` config와 동명 캐시 체크포인트로 episode 0의
  프레임 0–2를 추론: 16차원 action, 40-step chunk, 유효 미래 action 120개
- 결과 저장, SSE 완료 상태, 실제 예측/정답 그래프, JSON/CSV 내보내기 확인
- 390 / 1440 / 1920px 화면과 라이트·다크 모드에서 주요 화면 확인

이 3프레임 실행은 도구의 연결 검증이며 모델 전체 성능 측정이 아닙니다. 이 기록은
결과 작업 공간 재설계 이전의 것이며, 재설계 이후의 실제 추론 검증과 SDK 정확도
최종 검증은 별도 기록으로 남깁니다.
실행 기록 `1f607d94-fb34-4cfb-96aa-cabe5a882a88`에서 결과를 다시 열 수 있습니다.
정식 비교에는 원하는 모델·검증 데이터·episode를 선택해 전체 평가를 실행하세요.

기존 OpenPi의 torchvision 영상 디코더는 deprecation warning을 출력합니다.
이번 테스트와 실제 추론은 통과했으며, 이 경고를 숨기거나 원격 환경을 변경하지 않았습니다.
전체 trace는 메모리에 유지하므로 많은 episode를 한 번에 평가할 때는 데이터 크기에
비례해 로컬 서버와 브라우저의 메모리를 사용합니다.
