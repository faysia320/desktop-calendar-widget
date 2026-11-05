# Desktop Calendar Widget (PoC)

Google·Outlook 일정을 바탕화면에 표시하는 Windows 위젯의 기술 검증용 앱입니다.

## 실행

```powershell
pnpm install
pnpm tauri dev
```

`Ctrl+Alt+K`를 누르면 위젯이 맨 앞으로 나오고, 다시 누르면 바탕화면 고정 상태로 돌아갑니다.

## 캘린더 연동 설정

`.env.example`을 `.env.local`로 복사한 뒤 아래에서 발급한 값을 입력합니다.

### Google

1. Google Cloud Console에서 프로젝트를 만들고 Google Calendar API를 사용 설정합니다.
2. OAuth 동의 화면에 `calendar.events` 범위를 추가합니다.
3. 유형이 "데스크톱 앱"인 OAuth 클라이언트를 만들고 ID를 `GOOGLE_CLIENT_ID`, 보안 비밀을 `GOOGLE_CLIENT_SECRET`에 입력합니다.

게시 상태가 `Testing`이면 로그인이 7일 뒤 만료됩니다. `In production`으로 게시하면 검증 전에는 로그인할 때 "확인되지 않은 앱" 경고가 표시됩니다.

### Microsoft

1. Microsoft Entra 관리 센터의 앱 등록에서 새 앱을 만듭니다. 계정 유형은 조직 계정과 개인 계정을 모두 허용합니다.
2. "모바일 및 데스크톱 애플리케이션" 플랫폼에 리디렉션 URI `http://localhost`를 추가합니다.
3. 애플리케이션 ID를 `MICROSOFT_CLIENT_ID`에 입력합니다.
