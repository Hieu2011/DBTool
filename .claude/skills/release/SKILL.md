---
name: release
description: Phát hành một bản DbStudio mới - tăng version, viết mục CHANGELOG, commit, push; hook pre-push tự build và đẩy exe lên thư mục update trên cloud. Dùng khi anh nói "release", "deploy", "ra bản mới", "tăng version rồi push". Tham số tuỳ chọn là số version (vd 1.2.0).
disable-model-invocation: true
---

# Phát hành DbStudio

Anh gọi skill này = anh đã cho phép **commit và push đúng một lần** cho bản phát hành này. Không áp dụng cho lần sau.

Cơ chế: push lên `main` làm đổi `<Version>` thì `scripts/hooks/pre-push` chạy `scripts/release.ps1 -IfNewer`: build exe, upload `DbStudio-<version>.exe`, kiểm dung lượng, ghi `version.json`, rồi mới đẩy code. Release lỗi thì push bị chặn, GitHub và cloud không lệch nhau.

## Các bước

1. **Xem hiện trạng** (chỉ đọc):
   - `git status --short`, `git log origin/main..HEAD --oneline`, nhánh phải là `main`.
   - `powershell -NoProfile -ExecutionPolicy Bypass -File .claude\skills\release\check-cloud.ps1` → version đang ở cloud, version trong project.
   - Lỗi 401 ở bước này: dừng, báo anh tạo lại app password trên cloud rồi tự chạy `.\scripts\release.ps1 -SaveCredential` trong terminal của anh. Không bao giờ hỏi hay nhận mật khẩu qua chat.
2. **Chọn version**: tham số anh đưa; không có thì tăng số cuối của version lớn hơn giữa project và cloud (1.1.4 → 1.1.5). Version mới phải lớn hơn cloud, nếu không hook bỏ qua bước release.
3. **Kiểm tra code** nếu có file chưa commit hoặc commit chưa push: `dotnet build DbStudio.sln` và `cd web; npm run typecheck`. Lỗi thì dừng và báo nguyên nhân.
4. **CHANGELOG.md**: thêm mục `## <version> — <yyyy-MM-dd>` ngay trên mục mới nhất. Nội dung lấy từ thay đổi kể từ bản trước (`git log`, `git diff` so với commit của bản trước + file chưa commit). Viết tiếng Việt, mỗi dòng một thay đổi mà người dùng thấy được, ngắn gọn - đây là ghi chú hiện trong form Updates của app. Không ghi việc nội bộ (refactor, script, tài liệu).
5. **Version**: sửa `<Version>` trong `src/DbStudio.Host/DbStudio.Host.csproj`.
6. **Commit**: `git add -A` rồi xem lại `git status --short` trước khi commit - không commit file chứa bí mật (`.env`, `release.xml`, `update.json`) hay file rác; có file lạ thì hỏi anh. Message `release: <version>` (thân commit liệt kê ngắn các thay đổi nếu gộp cả code), kết thúc bằng dòng `Co-Authored-By` theo quy định của phiên. Working tree phải sạch sau commit, hook đòi vậy.
7. **Push**: `git push` với timeout 10 phút - hook build và upload khoảng 90 MB nên đứng vài phút là bình thường. App đang mở không sao (`publish.ps1` tự đổi tên exe đang chạy thành `.old`).
8. **Kiểm tra lại**: chạy lại `check-cloud.ps1`: version ở cloud = version mới và `sha256` của cloud = của `dist\DbStudio.exe`; `git status -sb` không còn `ahead`.
9. **Báo anh**: version, commit, kết quả đối chiếu cloud, và nội dung mục changelog đã ghi.

## Khi hỏng giữa chừng

- Hook báo `commit or stash your changes first`: còn file chưa commit → quay lại bước 6.
- Hook báo thiếu mục `## <version>` trong CHANGELOG: số ở CHANGELOG và csproj lệch nhau.
- Build / upload lỗi: không có gì lên GitHub. Sửa nguyên nhân rồi `git push` lại, không cần commit mới và không tăng version thêm.
- Upload xong nhưng push lên GitHub lỗi (mạng): cloud đã có bản mới; `git push` lại, hook thấy cloud đã có version đó và chỉ đẩy code.

## Không được làm

- Không dùng `DBSTUDIO_SKIP_DEPLOY`, `--no-verify`, `--force` để lách hook.
- Không xoá gì trên cloud (exe cũ do anh tự dọn).
- Không ghi link chia sẻ, mật khẩu, app password vào repo, commit message hay CHANGELOG.
- Không phát hành đè một version đã có trên cloud trừ khi anh yêu cầu rõ (khi đó chạy `.\scripts\release.ps1` tay, không qua hook).
- File `.ps1` phải thuần ASCII.
