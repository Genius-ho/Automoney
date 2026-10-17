# 리눅스 서버로 옮기기

## 빠른 순서: 192.168.1.50 서버의 `moohan/virtual`에 설치
`사용자`는 서버 로그인 계정(무한매수를 돌리는 계정)으로 바꿔 쓰세요. 포트 8100은 예시이며, 무한매수가 쓰지 않는 번호면 됩니다.

**윈도우 (PowerShell)**
```powershell
cd C:\AIAUTO
.venv-stock-ai\Scripts\python.exe deploy\package_for_linux.py
scp dist\stock-ai-linux-*.tar.gz 사용자@192.168.1.50:/tmp/
ssh 사용자@192.168.1.50
```
**서버 (192.168.1.50)**
```bash
ls ~/moohan                                    # moohan 폴더 위치 확인
ss -ltnp | grep -E ':8100 ' || echo "8100 비어 있음"   # 포트가 비어 있는지 확인
sudo apt update && sudo apt install -y python3 python3-venv curl
cd /tmp && tar xzf stock-ai-linux-*.tar.gz
sudo APP=/home/사용자/moohan/virtual RUN_USER=사용자 PORT=8100 HOST=0.0.0.0 SERVICE=moohan-virtual \
     bash /tmp/stock-ai/deploy/install_linux.sh
```
`설치 완료` 메시지가 나오면 같은 공유기에 연결된 PC 브라우저에서 `http://192.168.1.50:8100`을 엽니다.
`HOST=0.0.0.0`은 내부망(192.168.1.x)에서 접속하기 위한 설정입니다. 공유기에서 이 포트를 외부로 포트포워딩하지 마세요(로그인 기능이 없습니다).

**확인이 끝나면 윈도우 쪽 서버 끄기 (PowerShell)**
```powershell
Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'stock_ai_analyzer' } | ForEach-Object { Stop-Process -Id $_.ProcessId }
```
이후 서버 관리는 `sudo systemctl status|restart moohan-virtual`, 로그는 `sudo journalctl -u moohan-virtual -f`.
무한매수 메뉴 연결은 서버의 `~/moohan` 폴더에서 Claude Code를 실행해 요청하면 됩니다.

---

준비물: Ubuntu 22.04/24.04 같은 리눅스 서버(메모리 4GB 이상 권장, 8GB면 여유), SSH 접속, `sudo` 권한.
Python 3.11 이상이 필요합니다(Ubuntu 24.04 기본 3.12). 22.04는 `deadsnakes`로 3.11+를 설치한 뒤 `PYTHON=python3.12`를 지정합니다.

## 1. 윈도우에서 묶기 (서버를 켜 둔 채로 가능)
```powershell
cd C:\AIAUTO
.venv-stock-ai\Scripts\python.exe deploy\package_for_linux.py
```
`dist\stock-ai-linux-날짜.tar.gz`가 만들어집니다. 코드, 화면 파일, 지금까지의 가상 투자 기록(DB 스냅샷), 가격 캐시가 들어 있습니다.

## 2. 서버로 복사
```powershell
scp dist\stock-ai-linux-*.tar.gz 사용자@서버주소:~/
```
(WinSCP·FileZilla 같은 프로그램으로 올려도 됩니다.)

## 3. 서버에서 설치
```bash
sudo apt update && sudo apt install -y python3 python3-venv curl
tar xzf stock-ai-linux-*.tar.gz
cd stock-ai
sudo bash deploy/install_linux.sh
```
`/opt/stock-ai`에 설치하고, `stockai` 계정으로 실행하는 systemd 서비스를 등록합니다. 서버가 재부팅되면 자동으로 켜지고, 앱이 죽으면 10초 뒤 다시 켜집니다. 시간대는 서울(`TZ=Asia/Seoul`)로 고정되어 장 마감 후 18:10~18:40 정산이 그대로 돌아갑니다.

## 4. 윈도우 쪽은 끄기
서버에서 정상 동작을 확인한 뒤 윈도우의 서버를 끕니다. 두 곳이 동시에 돌면 기록이 따로따로 쌓입니다.
옮기는 사이에 장 마감(18:00)이 지나면 그날 정산이 빠지니, 18:00 이전이나 정산(18:40)이 끝난 뒤에 옮기세요.
정산이 빠진 날이 있어도 다음 날 정산 때 밀린 날짜를 차례로 처리합니다.

## 5. 화면 보기 (보안)
앱에는 로그인 기능이 없습니다. 인터넷에 그대로 열지 말고, 아래 방법으로 접속하세요.

- **SSH 터널(가장 간단)**: 내 PC에서
  ```powershell
  ssh -N -L 8000:127.0.0.1:8000 사용자@서버주소
  ```
  를 켜 둔 상태로 브라우저에서 `http://127.0.0.1:8000`을 엽니다.
- **Tailscale 같은 사설망(VPN)**: 서버와 PC를 같은 사설망에 넣으면 어디서든 접속 가능. 이때는 서비스 실행 줄에 `--host 0.0.0.0`을 추가하고, 방화벽은 사설망에만 열어 둡니다.

## 6. 자주 쓰는 명령
```bash
sudo systemctl status stock-ai          # 상태
sudo journalctl -u stock-ai -f          # 실시간 로그
sudo systemctl restart stock-ai         # 재시작
curl http://127.0.0.1:8000/api/health   # 응답 확인
```
기록 백업: `/opt/stock-ai/stock_ai_data/stock-ai.sqlite` 파일을 복사합니다(서버를 멈추거나 `sqlite3 ... ".backup 파일"` 사용).

## 7. 코드 업데이트
윈도우에서 1~2단계를 다시 한 뒤 서버에서 `sudo bash deploy/install_linux.sh`를 실행합니다. 서버에 이미 있는 기록(`stock_ai_data`)은 덮어쓰지 않고 코드만 바뀝니다.

## 8. 기록을 처음부터 다시 시작하려면
```bash
sudo systemctl stop stock-ai
sudo -u stockai /opt/stock-ai/.venv-stock-ai/bin/python /opt/stock-ai/deploy/reset_virtual_records.py
sudo systemctl start stock-ai
```
지우기 전에 `stock_ai_data/backups/`에 전체 백업을 남깁니다. 다시 시작은 화면의 "계좌 운영" 카드 버튼으로 합니다.
