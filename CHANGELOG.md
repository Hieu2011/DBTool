# Changelog

Mỗi bản phát hành một mục, bản mới nhất ở trên. Nội dung của mục là phần ghi chú hiện trong app khi có bản mới (Help → Check for updates), nên viết ngắn gọn cho người dùng đọc.

## 1.1.6 — 2026-11-26

- Để thống kê người dùng, mỗi ngày một lần app báo về máy chủ update: tên đăng nhập Windows, tên máy, địa chỉ IP và version (form Updates có ghi rõ)

## 1.1.5 — 2026-11-25

- Editor tự xuống hàng khi dòng dài hơn khung (View → Word wrap hoặc Alt+Z để tắt / bật, nhớ qua lần tắt app)
- Alt + click thêm một con trỏ tại chỗ bấm, bấm lại vào con trỏ đó để bỏ (Alt + kéo vẫn là chọn khối cột)

## 1.1.4 — 2026-11-25

- Gợi ý tự bật lại sau mỗi lần gõ hoặc xoá (gõ sai, xoá đi gõ lại không cần Ctrl+Space nữa)

## 1.1.3 — 2026-11-25

- Nút Update and restart dùng được cả khi file exe không tên DbStudio.exe (vd file tải từ cloud DbStudio-1.1.2.exe)
- Form Updates báo rõ lý do khi bản đang chạy không tự update được

## 1.1.2 — 2026-11-25

- Editor: chọn khối cột để sửa đồng loạt (Alt + kéo chuột, Alt + Shift + mũi tên), Ctrl + click thêm con trỏ
- Ctrl+F / Ctrl+H mở tìm / thay thế của editor kể cả khi đang đứng ở lưới hay cây
- Thanh công cụ có ô chọn connection: đổi connection của tab mà vẫn giữ nội dung đang gõ
- Giữ phiên làm việc: tắt app mở lại vẫn còn các tab editor và nội dung chưa lưu (giữ 7 ngày)
- Gợi ý: sau WHERE / ON chỉ còn alias và cột của các bảng trong câu lệnh, cột hiện kèm alias (PS.STOREID), chọn alias thì ra cột của nó
- Gợi ý: sau tên bảng / alias là WHERE, JOIN… thay vì danh sách bảng
- Gợi ý: sau FROM / JOIN có cả tên schema (chọn MASTERDATA thì ra bảng của nó)
- Hết giật khi gõ trên schema lớn (gợi ý sau FROM / JOIN không còn quét lại toàn bộ danh sách bảng)
- PostgreSQL: snippet chèn keyword chữ thường (Oracle vẫn in hoa)
- Thanh công cụ không còn bị cắt trên màn hình nhỏ

## 1.1.1 — 2026-11-25

- Form Updates hiện ngày phát hành của bản trên thư mục update
- Form Updates hiện ngày của bản đang chạy ngay dưới dòng Author
- Bản đầu tiên phát hành tự động khi push (để thử nút Update and restart)

## 1.1.0 — 2026-11-25

- Bản phát hành đầu tiên qua kênh update
- Tự update: Help → Check for updates (tải bản mới, kiểm SHA-256, thay exe, mở lại)
- Sidebar là một cây cuộn chung: connection là nút gốc, một ô lọc, icon theo loại DB, số dòng cạnh tên bảng
- Chấm trạng thái kết nối trên mỗi connection, lỗi kết nối hiện popup kèm Retry / Edit connection
- Form connection: chọn loại DB bằng thẻ, thanh chạy và thông báo khi Test connection
- Lưới: chữ to hơn, sửa cột nhị phân dạng hex, sửa cột object / array của MongoDB, mở ô bị khoá để copy
- Redis: thêm key, xoá một key / các key đã chọn / cả thư mục theo prefix
- Exe nén bên trong: 94 MB thay vì 224 MB
