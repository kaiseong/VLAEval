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
6. 결과에서 episode와 action 차원을 선택해 정답/예측 그래프를 보고 JSON 또는
   CSV로 내보냅니다. 완료된 실행은 로컬 `.runs/`에 저장됩니다.

처음 모델을 로딩하거나 JAX를 컴파일할 때는 진행률이 잠시 움직이지 않을 수 있습니다.
단일 GPU에서 중복 모델 로딩을 피하기 위해 앱은 평가를 한 번에 하나만 실행합니다.

## 지표 해석

- **Episode 시간축 그래프**: 각 관측 프레임에서 예측한 action chunk의 첫 action과
  같은 프레임의 정답 action을 비교합니다. 로봇 실행이나 async action aggregation을
  재현한 closed-loop rollout이 아닙니다.
- **Chunk MAE / RMSE**: 예측 chunk와 정답 미래 action 시퀀스의 오차입니다.
  episode 끝에서 반복된 padding action은 점수에서 제외합니다.
- **차원별 / episode별 / horizon별 지표**: 특정 관절 또는 먼 미래 시점에서
  오차가 커지는지 구분합니다. horizon별 유효 표본 수도 함께 확인하세요.
- **첫 action 지표**: chunk 전체 오차와 분리하여 제공합니다.
- **추론 시간**: warmup을 제외한 관측 입력부터 실제 출력 배열 획득까지의 시간입니다.
  모델 로딩, 데이터 영상 읽기, SSH 왕복 시간과는 구분됩니다.

평가에는 체크포인트에 저장된 정규화 통계와 선택한 config의 입력/출력 변환을
사용합니다. RBY1의 관절 delta 출력은 절대 action으로 복원한 뒤 비교합니다.
관절과 gripper의 단위가 다를 수 있으므로 전체 평균만으로 판단하지 말고 차원별
지표를 함께 보세요. 오프라인 action 오차는 실제 로봇의 작업 성공률이 아닙니다.
학습에 사용한 episode라면 일반화 성능이 아니라 학습 데이터 재현 성능입니다.

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
- `tests/`: 작업 생명주기와 평가 계산의 회귀 테스트.

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

이 3프레임 실행은 도구의 연결 검증이며 모델 전체 성능 측정이 아닙니다.
실행 기록 `1f607d94-fb34-4cfb-96aa-cabe5a882a88`에서 결과를 다시 열 수 있습니다.
정식 비교에는 원하는 모델·검증 데이터·episode를 선택해 전체 평가를 실행하세요.

기존 OpenPi의 torchvision 영상 디코더는 deprecation warning을 출력합니다.
이번 테스트와 실제 추론은 통과했으며, 이 경고를 숨기거나 원격 환경을 변경하지 않았습니다.
전체 trace는 메모리에 유지하므로 많은 episode를 한 번에 평가할 때는 데이터 크기에
비례해 로컬 서버와 브라우저의 메모리를 사용합니다.
