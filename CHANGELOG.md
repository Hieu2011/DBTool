# Changelog

Mỗi bản phát hành một mục, bản mới nhất ở trên. Nội dung của mục là phần ghi chú hiện trong app khi có bản mới (Help → Check for updates), nên viết ngắn gọn cho người dùng đọc.


## 1.1.10 — 2026-11-27

- Cuộn tới cuối lưới là tải tiếp các dòng kế, không chạy lại câu lệnh và không còn giới hạn 100.000 dòng (PostgreSQL, Oracle); nút More rows đọc tiếp 10.000 dòng
- Tab Data của bảng: rời tab rồi quay lại vẫn cuộn tải tiếp được
- Sửa lỗi nút Export data dưới lưới bấm không hiện menu Excel / CSV
- Oracle: đọc dữ liệu nhanh hơn với bảng nhiều cột rộng và cột CLOB / BLOB
- Hiện output của câu lệnh: DBMS_OUTPUT (Oracle), RAISE NOTICE (PostgreSQL); Oracle chạy được EXEC proc(...)
- Câu lệnh có :tên hoặc &tên: hỏi giá trị trước khi chạy
- Explain plan: nút Explain hoặc Ctrl+Shift+E
- Tab Source: lỗi compile được gạch đỏ ngay tại dòng lỗi
- Lưới: kéo đổi độ rộng cột, chuột phải tiêu đề để ghim / ẩn cột, Ctrl+F tìm trong lưới, tổng Count / Sum / Avg của vùng chọn, khung Value xem cả giá trị ô
- Connection → Find object… (Ctrl+Shift+O): tìm bảng, view, store theo tên trên mọi schema
- Connection → Sessions and locks…: xem session, session đang bị khoá, Kill session
- Bản cài nhỏ hơn: 94 MB còn 69 MB

## 1.1.9 — 2026-11-26

- Lưới kết quả: giữ Ctrl để chọn thêm nhiều vùng ô rời nhau, Ctrl+C chép tất cả
- Lưới kết quả: kéo chuột ở cột số dòng để chọn nhiều dòng; chọn một dòng rồi Ctrl+C chép cả dòng
- Lưới kết quả: Ctrl+V dán dòng / vùng ô đã copy (kể cả từ Excel) vào các ô sửa được, ví dụ dán vào dòng mới; bấm Save mới ghi

## 1.1.8 — 2026-11-26

- Lưới kết quả: chuột phải → Generate script as → INSERT / WHERE IN () / WHERE AND OR / UPDATE, ra tab SQL, file hoặc clipboard (UPDATE tìm theo khoá chính)
- Lưới kết quả: chọn vùng ô bằng kéo chuột, Shift + click hoặc Shift + mũi tên; Ctrl+C chép đúng vùng đó
- Rê chuột lên cột hiện kiểu đầy đủ, NOT NULL, khoá chính và comment; thẻ của bảng liệt kê cột kèm kiểu và comment
- Ctrl + click (hoặc F12) vào tên cột mở bảng chứa cột đó
- Tab Source của store có gợi ý, hover, Ctrl + click và Alt + click như tab SQL
- Tab kết quả hiện tên câu query in đậm tách khỏi số dòng (vd SELECT cm_voucher · 11 rows)
- Chấm trạng thái của connection hết đỏ sau khi Retry thành công

## 1.1.7 — 2026-11-26

- Store (procedure / function / package): sửa code ngay ở tab Source rồi Save (Ctrl+S), có Undo / Redo / Comment; Oracle compile lỗi thì báo và mở tab Errors
- Store: Open in editor mở bản debug của thân store - tham số thay bằng giá trị mẫu (ngày là hôm nay) kèm comment tên tham số, chạy được từng câu query
- Form Execute tự điền giá trị default của tham số
- Oracle: dòng đầu của Source hiện đủ SCHEMA.TÊN, hết khoảng trống thừa
- Khung kết quả: mũi tên lên / xuống và nút ✕ trên thanh chia để ẩn hoặc phóng to; khi chạy query có thanh chạy, số giây và nút Stop
- Tab: kéo thả để đổi thứ tự, dấu ● trên tab chưa lưu
- Connection: icon chỉ có màu khi đã kết nối, Disconnect ngắt cả connection và thu gọn cây, trạng thái sidebar khớp với thanh công cụ
- Connection: menu chuột phải (Connect, Disconnect, New SQL tab, Refresh, Edit, Delete), nút Edit cạnh nút Reload
- Form connection: nút con mắt để xem mật khẩu đang gõ
- Thanh công cụ editor: Undo / Redo, nút Comment và Format có chữ
- Version hiện trên thanh tiêu đề cửa sổ
- Hộp hỏi / thông báo theo màu của app, không còn hiện địa chỉ 127.0.0.1
- Chuỗi trong nháy đơn màu cam nhạt thay cho đỏ

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
