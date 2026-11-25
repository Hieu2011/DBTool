# Changelog

Mỗi bản phát hành một mục, bản mới nhất ở trên. Nội dung của mục là phần ghi chú hiện trong app khi có bản mới (Help → Check for updates), nên viết ngắn gọn cho người dùng đọc.

## 1.1.1 — 2026-11-25

- Form Updates hiện ngày phát hành của bản trên thư mục update
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
