# ICONIA Firmware (ESP32)

ICONIA AI 인형(성인 사용자 대상 IoT 제품)의 ESP32 펌웨어 리포지토리입니다.
실제 코드가 동작하는 기준으로 본 문서를 작성했으며, 명세 외 기능은 포함하지 않습니다.

> 본 제품은 성인 한정 사용자 대상입니다. 어린이용 장난감 안전 기준은 적용 대상이 아닙니다.

---

## 폴더 구조

```
HW/
├─ ICONIA Firmware/          # 메인 펌웨어
│   ├─ ICONIA_Firmware.ino
│   ├─ iconia_app.h / iconia_app.cpp
│   ├─ iconia_config.h
│   └─ iconia_protocol.h
└─ ICONIA Firmware Unit/     # 서버 정합성 강화 빌드 (firmware_version 필드 포함)
    ├─ ICONIA_Firmware.ino
    ├─ iconia_app.h / iconia_app.cpp
    ├─ iconia_config.h       # kFirmwareVersion = "ICONIA_FW_1.2.0"
    └─ iconia_protocol.h     # kFieldFirmwareVersion = "firmware_version"
```

두 폴더는 서로 독립적인 Arduino 스케치이며, 동일한 동작 시퀀스를 공유합니다.
**`ICONIA Firmware Unit`** 은 서버에 펌웨어 버전을 함께 보고하는 확장 빌드로,
서버에서 디바이스 업그레이드 추적이 필요할 때 이 쪽을 플래시합니다.

| 구분 | Firmware | Firmware Unit |
|---|---|---|
| 멀티파트 `firmware_version` 필드 | 미전송 | 전송 (`ICONIA_FW_1.2.0`) |
| 그 외 동작 | 동일 | 동일 |

---

## 하드웨어 구성 (코드에 정의된 핀맵)

`iconia_config.h` 기준입니다. 실제 PCB 핀맵이 다르면 이 헤더 한 곳만 수정합니다.

### MCU / 카메라
- ESP32-WROOM-32 (Arduino-ESP32 core 3.x, ESP-IDF 5.x 기반)
- OV2640 (AI Thinker ESP32-CAM 핀맵)

### 핀 배정
| 기능 | GPIO | 비고 |
|---|---|---|
| 터치 (오른쪽) | 13 | RTC GPIO, EXT1 wakeup, active HIGH |
| 터치 (왼쪽) | 14 | RTC GPIO, EXT1 wakeup, active HIGH |
| 배터리 ADC | 33 | ADC1, 분압비 2.0, ADC_11db |
| LED | 4 | 상태 표시 |
| 카메라 PWDN | 32 | Deep Sleep 중 HIGH 유지(RTC hold) |
| 카메라 XCLK | 0 | 20 MHz |
| 카메라 SCCB SDA / SCL | 26 / 27 | |
| 카메라 D0~D7 | 5, 18, 19, 21, 36, 39, 34, 35 | |
| 카메라 VSYNC / HREF / PCLK | 25 / 23 / 22 | |

### 배터리 / 캡처 파라미터
- 분압 후 ADC1 채널에서 16회 오버샘플 평균
- 만충 4.20 V → 0% 임계 3.30 V (선형 매핑)
- 5% 미만이면 촬영·전송 생략 후 즉시 Deep Sleep 복귀
- 캡처 해상도: PSRAM 있음 → VGA / JPEG quality 12, 없음 → VGA / quality 14

---

## 동작 시퀀스

### 1. 부팅 직후
1. CPU 클럭을 80 MHz로 낮춰 초기 전류 절감
2. Task Watchdog 30 s 등록 (Wi-Fi / TLS 데드락 방지)
3. 빌드 시 주입된 API Key·엔드포인트가 placeholder인지 검사 → 검출 시 영구 Deep Sleep
4. NVS(`iconia` 네임스페이스)에서 Wi-Fi 자격증명 로드

### 2. Wi-Fi 자격증명이 없을 때 — BLE 프로비저닝
1. BLE 광고 시작
   - 디바이스명: `ICONIA-XXXX` (XXXX = MAC 마지막 4자리)
   - 광고 인터벌 1280 ms ~ 2560 ms (절전)
2. GATT 서비스 (UUID `48f1f79e-817d-4105-a96f-4e2d2d6031e0`)
   | Characteristic | UUID 끝자리 | 속성 |
   |---|---|---|
   | SSID | `...e1` | Write Without Response |
   | Password | `...e2` | Write Without Response |
   | Status | `...e3` | Notify / Read |
3. SSID + Password 둘 다 수신되면 즉시 Wi-Fi 연결 시도
4. 성공 시 NVS 저장 → Status에 `provisioning_success` 통지 → Deep Sleep
5. 2분(`kProvisioningTimeoutMs`) 동안 자격증명을 받지 못하면 Status에 `timeout` 후 Deep Sleep
6. Status 통지 키워드: `advertising`, `connected`, `wifi_connecting`, `wifi_failed`, `nvs_save_failed`, `invalid_credentials`, `provisioning_success`, `timeout`

### 3. 평상시 — 터치 → 촬영 → 업로드
1. Deep Sleep 대기 (EXT1 wakeup 마스크: GPIO 13 / 14, ANY_HIGH)
2. 터치로 wakeup → wakeup status 비트로 좌·우 방향 결정
3. 2 s 소프트웨어 디바운스
4. 배터리 ADC 측정 (16회 평균). 5% 미만이면 종료 후 Deep Sleep
5. 카메라 PWDN LOW → OV2640 init → 워밍업 프레임 1장 폐기 → 캡처
6. CPU를 240 MHz로 승격, Wi-Fi STA 연결 (최대 15 s, 모뎀 슬립 사용)
7. HTTPS POST `/api/event` (multipart/form-data)
8. 응답 / 헤더 / 바디에서 `X-ICONIA-Command: enter_provisioning` 검사
9. Wi-Fi/카메라 정리 → Deep Sleep
   - 명령이 있었으면 NVS Wi-Fi 자격증명 삭제 후 BLE 프로비저닝 진입

### 4. Deep Sleep 진입 정리
- Wi-Fi `disconnect → stop → deinit`
- BLE Bluedroid disable + controller deinit + `ESP_BT_MODE_BTDM` 메모리 회수
- 카메라 PWDN 핀에 RTC hold(HIGH) 적용 (슬립 중 누설 차단)
- `esp_sleep_config_gpio_isolate()` 로 Wakeup 핀 외 모든 GPIO 격리
- RTC peripherals / RTC SLOW·FAST MEM 도메인 OFF

### 5. 재시도·실패 정책
- Wi-Fi 연결: 3회, 회당 800 ms 대기
- 업로드: 3회, 회당 1 s 대기
- 전송 실패 시 **로컬 저장 없이 포기** (사용자 음성·이미지 데이터 잔존 방지)

---

## 서버로 보내는 페이로드

`POST <kApiEndpoint>` (HTTPS, `Content-Type: multipart/form-data`)

| 헤더 | 값 |
|---|---|
| `X-API-Key` | 빌드 시 주입된 키 |
| `User-Agent` | `ICONIA-ESP32/1.0` |
| `Connection` | `close` |

| 폼 필드 | 값 |
|---|---|
| `touch` | `"left"` 또는 `"right"` |
| `device_id` | MAC 주소 `XX:XX:XX:XX:XX:XX` |
| `battery` | 0~100 정수 |
| `firmware_version` | `ICONIA_FW_1.2.0` (Firmware Unit 빌드만) |
| `image` | JPEG 바이너리 (`event.jpg`, `image/jpeg`) |

서버 응답 헤더 또는 바디에 `X-ICONIA-Command: enter_provisioning` 이 포함되면
펌웨어는 NVS 자격증명을 삭제하고 즉시 BLE 프로비저닝 모드로 재진입합니다.

---

## 빌드 / 플래시 (Arduino IDE 2.x)

### 1. 보드 설정
- Boards Manager → **esp32 by Espressif** core 3.x 설치
- Board: **ESP32 Dev Module** (또는 사용 모듈)
- Partition Scheme: **Huge APP** 권장 (BLE + 카메라 라이브러리 동시 포함)
- PSRAM: **Enabled** (있을 경우 VGA quality 12 사용 가능)

### 2. 라이브러리
ESP32 core 3.x 에 기본 포함된 다음 헤더만 사용합니다.
추가 외부 라이브러리는 필요 없습니다.
- `WiFi.h`, `WiFiClientSecure.h`, `Preferences.h`, `BLEDevice.h` 등
- `esp_camera.h`, `esp_sleep.h`, `esp_task_wdt.h`, `driver/rtc_io.h`

### 3. 비밀값 주입 (빌드 시점)
스케치 폴더에 **`build_opt.h`** 파일을 만들어 다음 매크로를 정의합니다.
이 파일은 절대 커밋하지 않습니다 (`.gitignore` 등록 권장).

```
-DICONIA_API_ENDPOINT="\"https://api.iconia.example.com/api/event\""
-DICONIA_API_KEY="\"<32+ char random key>\""
-DICONIA_CERT_FP_SHA1="\"AA:BB:CC:...:99\""    # 선택, 서버 leaf 인증서 핀닝
```

매크로가 빠지면 부팅 직후 placeholder 검출 가드가 디바이스를
영구 Deep Sleep으로 보냅니다 (네트워크 코드 진입 자체를 차단).

### 4. 선택 빌드 플래그
| 매크로 | 의미 |
|---|---|
| `-DICONIA_PRODUCTION_BUILD=1` | Serial 로그 OFF (출하용) |
| `-DICONIA_BLE_SECURE=1` | BLE Just Works + MITM 본딩 + 16바이트 nonce 적용 |
| `-DICONIA_ALLOW_INSECURE_TLS=1` | bring-up 전용. 운영 사용 금지 |

### 5. 보안 권장사항
- 운영 빌드에서 `kServerRootCaPem` 에 실제 root CA PEM을 박거나 NVS로 주입
- `setInsecure()` 사용 금지 (`ICONIA_ALLOW_INSECURE_TLS` OFF 유지)
- API Key는 펌웨어 바이너리에 평문 상수로 들어가므로,
  공장 플래시 단계에서 디바이스별 고유 키로 주입하는 것을 권장

---

## 펌웨어 책임 범위

펌웨어는 다음만 담당합니다.

- BLE 프로비저닝 + NVS 저장
- EXT1 터치 wakeup 처리
- 배터리 ADC 측정
- OV2640 JPEG 캡처
- HTTPS multipart 업로드 (재시도 3회)
- 서버 명령 `enter_provisioning` 해석
- Deep Sleep 복귀

이미지 영구 저장, Vision 분석, AI 응답 생성 등은 모두 서버·AI 도메인의 책임이며,
펌웨어는 전송 후 즉시 자원을 정리하고 슬립으로 복귀합니다.
