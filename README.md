# DbStudio

DB client cá nhân chạy trên Windows, lấy ý tưởng từ DBeaver, có autocomplete tên bảng/cột kiểu dbForge.
Hỗ trợ PostgreSQL, Oracle, MongoDB và Redis.

Chỉ dùng nội bộ trên một máy: API bind `127.0.0.1`, không mở port ra ngoài.

---

## 1. Kiến trúc

```
┌──────────────── DbStudio.exe (.NET 8, WinForms) ────────────────┐
│  MainForm ── WebView2 ──► React + Vite + Monaco (embedded)       │
│                              │ fetch /api/* + X-DbStudio-Token   │
│  Kestrel 127.0.0.1:<port ngẫu nhiên>                             │
│   ├─ DbStudioApi        (Minimal API)                            │
│   ├─ ProviderRegistry   → PostgresProvider | OracleProvider      │
│   ├─ MetadataCache      (schema/table/column theo connection)    │
│   ├─ QueryRegistry      (queryId → CancellationTokenSource)      │
│   ├─ SessionRegistry    (sessionId → connection mở của tab)      │
│   └─ DpapiConnectionStore (%APPDATA%\DbStudio\connections.json)  │
└──────────────────────────────────────────────────────────────────┘
```

Luồng khởi động:

1. `Program.Main` dựng Kestrel trên `127.0.0.1:0` (OS cấp port) và sinh token ngẫu nhiên cho lần chạy này.
2. `MainForm` tạo WebView2, inject `window.__DBSTUDIO_TOKEN__`, rồi load `http://127.0.0.1:<port>/`.
3. UI (React) được nhúng vào exe dưới dạng embedded resource (`wwwroot/**`), nên publish ra đúng **1 file**.
4. Đóng cửa sổ thì Kestrel dừng theo.

| Thành phần | Công nghệ |
|---|---|
| Host | .NET 8 WinForms + `Microsoft.Web.WebView2` |
| API | ASP.NET Core Minimal API (in-process) |
| PostgreSQL | `Npgsql` |
| Oracle | `Oracle.ManagedDataAccess.Core` (không cần Oracle Client) |
| UI | React 19 + Vite + Tailwind CSS v4 |
| Editor | `monaco-editor` (bundle local, không dùng CDN) |
| Result grid | `@tanstack/react-virtual` (virtualized) |

---

## 2. Yêu cầu

- Windows 10/11 x64.
- .NET 8 SDK.
- Node.js 20+.
- WebView2 Runtime: Windows 11 có sẵn. Windows 10 nếu thiếu, app sẽ báo và đưa link cài.

---

## 3. Cấu trúc thư mục

```
DbStudio/
├─ DbStudio.sln
├─ Directory.Build.props          # Nullable, ImplicitUsings, LangVersion chung
├─ scripts/
│  ├─ dev.ps1                     # Vite + dotnet watch --dev
│  └─ publish.ps1                 # build UI + publish single exe vào dist/
├─ src/
│  ├─ DbStudio.Core/              # model + interface, không phụ thuộc driver
│  │  ├─ Models.cs                # ConnectionProfile, QueryResult, SchemaMetadata...
│  │  └─ IDbProvider.cs           # IDbProvider, IConnectionStore
│  ├─ DbStudio.Providers/
│  │  ├─ AdoProviderBase.cs       # chạy query, giới hạn dòng, cancel, load metadata
│  │  ├─ PostgresProvider.cs
│  │  ├─ OracleProvider.cs
│  │  └─ ProviderRegistry.cs
│  └─ DbStudio.Host/              # exe
│     ├─ Program.cs               # entry, --dev
│     ├─ MainForm.cs              # WebView2
│     ├─ ApiHost.cs               # Kestrel, DI, token middleware, embedded UI
│     ├─ Api/DbStudioApi.cs       # endpoints
│     ├─ Services/                # DpapiConnectionStore, MetadataCache, QueryRegistry
│     └─ wwwroot/                 # output của `npm run build` (gitignored)
└─ web/
   ├─ vite.config.ts              # proxy /api → 5280, build ra ../src/DbStudio.Host/wwwroot
   └─ src/
      ├─ App.tsx                  # layout: sidebar connection + tab workspace
      ├─ api.ts                   # fetch wrapper (gắn token)
      ├─ monaco.ts                # load Monaco local, worker, theme sáng/tối
      ├─ sql/completion.ts        # autocomplete (giai đoạn 1: regex)
      ├─ sql/statements.ts        # tách statement, tìm statement tại con trỏ
      └─ components/
         ├─ ConnectionList.tsx
         ├─ ConnectionDialog.tsx
         ├─ QueryWorkspace.tsx    # editor + toolbar + result + status bar
         ├─ ObjectTree.tsx        # cây object ở sidebar
         ├─ ObjectViewer.tsx      # tab chi tiết object: lưới + DDL
         └─ ResultGrid.tsx
```

---

## 4. Chạy khi dev

### Cách 1: script

```powershell
.\scripts\dev.ps1
```

Script mở Vite (`localhost:5173`, có hot reload) ở cửa sổ riêng, rồi chạy host với `--dev`. Ở chế độ này:

- API cố định ở `127.0.0.1:5280` và **không yêu cầu token**.
- Cửa sổ WebView2 load Vite dev server; DevTools (F12) và context menu được bật.
- Có thể mở thẳng `http://localhost:5173` bằng Chrome để debug.

### Cách 2: Visual Studio / Rider

1. Terminal: `cd web && npm install && npm run dev`.
2. Chạy project `DbStudio.Host` với profile **"DbStudio (dev, Vite)"** (đã có trong `launchSettings.json`).

### Chạy giống bản thật (UI nhúng trong exe)

```powershell
cd web; npm run build; cd ..
dotnet run --project src/DbStudio.Host
```

> Fresh clone chưa có `wwwroot`. Host vẫn build được và hiện trang nhắc chạy `npm run build`.

---

## 5. Build ra exe

```powershell
.\scripts\publish.ps1                      # self-contained, ~200 MB, copy máy nào cũng chạy
.\scripts\publish.ps1 -FrameworkDependent  # nhẹ hơn, máy cần .NET 8 Desktop Runtime
```

Kết quả: `dist\DbStudio.exe`.

Dữ liệu người dùng nằm ngoài exe:

| Đường dẫn | Nội dung |
|---|---|
| `%APPDATA%\DbStudio\connections.json` | Danh sách connection; password mã hoá DPAPI |
| `%LOCALAPPDATA%\DbStudio\WebView2\` | Profile của WebView2 |

---

## 6. API

Mọi request `/api/*` phải có header `X-DbStudio-Token` (trừ chế độ `--dev`).

| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/info` | Version, danh sách loại DB đang hỗ trợ |
| GET | `/api/connections` | Danh sách connection (không trả password, chỉ `hasPassword`) |
| POST | `/api/connections` | Thêm/sửa. `password` rỗng khi sửa = giữ password cũ |
| DELETE | `/api/connections/{id}` | Xoá |
| POST | `/api/connections/test` | Test kết nối từ dialog (timeout 20 s) |
| GET | `/api/connections/{id}/metadata?refresh=true&schema=X` | Bảng/view/cột + object khác; cache tới khi refresh hoặc sửa connection. `schema`: load thêm schema đó (Oracle) |
| GET | `/api/connections/{id}/object?schema=&name=&type=&signature=` | Chi tiết một object: các lưới (Columns, Indexes...) + DDL |
| GET | `/api/connections/{id}/routine?schema=&name=&type=&signature=` | Tham số của procedure/function cho form Execute |
| POST | `/api/routine/execute` | `{ queryId, connectionId, routine, arguments, maxRows }` → cursor trả về (lưới) + giá trị OUT; dừng bằng `/api/query/{queryId}/cancel` |
| POST | `/api/query` | `{ queryId, connectionId, sql, maxRows, sessionId?, autoCommit? }` → `QueryResult` |
| POST | `/api/query/{queryId}/cancel` | Dừng query đang chạy |
| POST | `/api/sessions/{sessionId}/open` | `{ connectionId }`: mở session của tab ngay (nút Connect), timeout 30 s |
| POST | `/api/sessions/{sessionId}/commit` | Commit transaction của tab (không có gì để commit thì bỏ qua) |
| POST | `/api/sessions/{sessionId}/rollback` | Rollback transaction của tab |
| DELETE | `/api/sessions/{sessionId}` | Đóng session khi đóng tab; transaction chưa commit bị rollback |

`queryId` do client sinh (`crypto.randomUUID()`), nhờ đó nút Stop huỷ được query ngay khi request chưa trả về.

Mã lỗi:

| Status | Khi nào | Body |
|---|---|---|
| 400 | Lỗi SQL / kết nối | `QueryError { message, position?, code? }` |
| 401 | Thiếu/sai token | rỗng |
| 404 | Không có connection | rỗng |
| 409 | Query bị huỷ | `QueryError` |

`position` (Postgres) là vị trí ký tự 1-based trong câu SQL; UI dùng nó để gạch đỏ đúng chỗ lỗi trong editor.

---

## 7. Hành vi query

- **Chạy:** nếu đang bôi đen thì chạy các statement trong phần bôi đen. Không bôi đen: `Ctrl+Enter` chạy statement tại con trỏ, `F5` (Run all) chạy mọi statement trong editor.
- **Nhiều statement:** UI tách statement rồi gửi **từng câu một** theo thứ tự (mỗi câu một request, cùng session của tab), dừng ở câu lỗi đầu tiên; các câu phía sau không chạy và status bar báo số câu bị bỏ. Mỗi câu có một tab kết quả (`1. 120 rows`, `2. 3 affected`, `3. Error`). Ở chế độ Auto-commit mỗi câu tự commit riêng, nên câu đã chạy xong không bị rollback khi câu sau lỗi.
- **Tách statement** (`web/src/sql/statements.ts`): tách theo `;`, bỏ qua chuỗi, identifier trong `"..."`, comment, dollar-quote của PostgreSQL (`$$`, `$tag$`) và q-quote của Oracle. Con trỏ nằm giữa hai statement thì lấy câu phía trước nếu còn cùng dòng, ngược lại lấy câu phía sau.
- **Block PL/SQL Oracle** (`BEGIN`, `DECLARE`, `CREATE PROCEDURE/FUNCTION/PACKAGE/TRIGGER/TYPE`) giữ nguyên `;` bên trong và kết thúc ở dòng chỉ có `/`. Thiếu dòng `/` thì block kéo tới hết editor.
- **Giới hạn dòng:** 100 / 1.000 / 10.000 (server chặn tối đa 100.000). Khi vượt giới hạn, provider gọi `DbCommand.Cancel()` trước khi đóng reader, để driver không kéo hết phần còn lại về.
- **Cancel:** token từ `QueryRegistry` được nối với `DbCommand.Cancel()`, chạy được cho cả Npgsql lẫn ODP.NET. `CommandTimeout = 0`, nút Stop đóng vai trò timeout.
- **Tab editor:** bấm một connection ở sidebar sẽ chuyển tới tab mới nhất của nó, chưa có thì mở tab đầu tiên. Nút `+` cuối dãy tab mở thêm tab cho connection của tab đang chọn (`TMS dev`, `TMS dev (2)`...). Các tab cùng connection dùng chung metadata nhưng mỗi tab có editor, kết quả và session riêng. Đóng tab còn transaction chưa commit sẽ hỏi lại.
- **Toolbar editor:** Run (`Ctrl+Enter`), Run all (`F5`), Stop, Comment (`Ctrl+/`), công tắc Auto-commit / Manual, Commit, Rollback, Limit; bên phải là trạng thái session của tab với nút Connect / Disconnect. Status bar hiện `Ln, Col` của con trỏ.
- **Session theo tab:** mỗi tab giữ một connection mở (`sessionId` do client sinh, mở khi tab mở hoặc ở lần chạy đầu), nên `SET search_path`, `ALTER SESSION`, temp table tồn tại giữa các lần chạy. Session đóng khi đóng tab, khi sửa/xoá connection, hoặc khi thoát app. Mất kết nối thì lần chạy sau tự mở lại.
- **Transaction:** mặc định Auto-commit. Bỏ tick thì các statement chạy chung một transaction tới khi bấm Commit / Rollback. Với PostgreSQL, mỗi statement được bọc savepoint để một câu lỗi (hoặc bị cắt dòng) không làm hỏng cả transaction. Không nên gõ tay `COMMIT`/`ROLLBACK` trong editor khi đang tắt Auto-commit.
- Request không có `sessionId` vẫn chạy trên connection dùng một lần như trước.
- **Chuẩn hoá giá trị** (`AdoProviderBase.Normalize`):
  - `decimal` → string, giữ đủ độ chính xác.
  - `long` vượt `2^53` → string, vì JavaScript mất chính xác.
  - `timestamptz` → giờ local, dạng `yyyy-MM-dd HH:mm:ss.ffffff`.
  - `bytea`/`RAW` → hex, cắt ở 64 byte.
  - Mảng → `1, 2, 3`.
- **Oracle:**
  - Tự bỏ `;` cuối với SQL thường, nhưng giữ nguyên cho block `BEGIN/DECLARE/CREATE PROCEDURE...`. Dấu `/` kiểu SQL*Plus cũng được bỏ.
  - `NUMBER` vượt phạm vi `decimal` của .NET được đọc qua `OracleDecimal.ToString()`.
  - Metadata load **từng schema một**, vì quét `ALL_TAB_COLUMNS` toàn instance rất chậm. Lúc đầu chỉ có schema đang đăng nhập; cây Objects liệt kê mọi schema (`ALL_USERS`) và load schema nào được mở. Autocomplete gợi ý được bảng của các schema đã load. Nút Refresh quay về schema đăng nhập, các schema đang mở trên cây tự load lại.

---

## 7b. Object explorer

Sidebar có thêm phần **Objects** cho connection của tab đang chọn.

- **Cây** (bố cục theo dbForge): schema → thư mục loại object, luôn hiện đủ kể cả khi rỗng (Oracle: Tables, Views, Packages, Procedures, Functions, Triggers, User Types, Sequences, Materialized Views, Synonyms) → object. Xổ một bảng ra **Columns / Constraints / Indexes / Triggers**; view ra cột; Oracle package ra các procedure/function bên trong, procedure/function ra tham số. Các mục ngoài Columns tải khi mở. Ô Filter lọc theo tên object.
- **Store của bảng:** dưới bảng/view còn có **Procedures / Functions** (Oracle thêm **Packages**) liệt kê code dùng bảng đó. Oracle lấy từ `ALL_DEPENDENCIES` (không thấy tham chiếu qua synonym); PostgreSQL tìm tên bảng trong mã nguồn hàm nên có thể dư (bảng trùng tên ở schema khác, tên nằm trong comment). Danh sách đi chung với metadata nên nút Refresh ở đây cũng làm mới autocomplete.
- **Menu chuột phải:** Open data, Count rows, View details, Copy name, Refresh, và nhóm **Generate script** (SELECT / INSERT / UPDATE / DELETE cho bảng, EXECUTE cho procedure/function, NEXTVAL cho sequence, CREATE (DDL), DROP). Script mở trong tab editor mới và không tự chạy; giá trị là placeholder `:ten_cot`, `WHERE` để trống dạng comment nên chạy nhầm sẽ báo lỗi cú pháp.
- **Tab Execute** (chuột phải procedure/function → `Execute…`, hoặc nút trong tab object): form liệt kê tham số theo catalog, mỗi tham số vào có ô nhập và ô NULL (không đụng tới = NULL). Bấm Execute thì server gọi routine, mở mọi cursor trả về thành lưới (mỗi cursor một tab) và đưa giá trị OUT / giá trị trả về vào tab Outputs. Chạy trên connection riêng rồi commit, không thuộc transaction của tab query. Số nhập với dấu `.`, ngày dạng `yyyy-MM-dd HH:mm:ss`. Chưa hỗ trợ procedure nằm trong package Oracle.
- **Tab object** (double-click hoặc nút `Info`): các lưới chi tiết và tab **DDL**.

  | Loại | PostgreSQL | Oracle |
  |---|---|---|
  | Bảng | Columns, Indexes, Constraints | Columns, Indexes, Constraints, Triggers |
  | View / materialized view | Columns (+ Indexes với mview) | Columns (+ Indexes với mview) |
  | Sequence | Properties | Properties |
  | Function / procedure / package | chỉ DDL | Errors (`ALL_ERRORS`) |

- **DDL:** PostgreSQL dựng lại từ `pg_catalog` (cột, default, identity, constraint, index, comment); Oracle dùng `DBMS_METADATA.GET_DDL` đã bỏ storage clause. Có nút Copy và **Open in editor**.
- **Open data** (hoặc nút `Data` trên cây) mở tab query với `SELECT * FROM ...` và chạy luôn, giới hạn theo Max rows. **Count rows** chạy `SELECT COUNT(*)`.
- **Oracle:** cây hiện mọi schema, schema đăng nhập đứng đầu và mở sẵn; schema khác load khi mở. Ô Filter tìm theo cả tên schema (để tìm schema chưa load) lẫn tên object của các schema đã load.
- Giới hạn: PostgreSQL cần 11+; DDL bảng PostgreSQL chưa gồm trigger, policy, grant, partition con.

---

## 8. Autocomplete

Hiện tại là bản đơn giản dựa trên regex (`web/src/sql/completion.ts`):

| Ngữ cảnh | Gợi ý |
|---|---|
| Sau `FROM` / `JOIN` / `UPDATE` / `INTO` | Bảng, view; chọn xong điền `schema.bảng` (bỏ schema nếu là schema đăng nhập của Oracle hoặc `public` của PostgreSQL) |
| `alias.` hoặc `table.` | Cột của bảng đó (alias lấy từ `FROM orders o`, `JOIN x AS y`) |
| `schema.` | Các bảng trong schema |
| Chỗ khác | Cột của các bảng trong câu, rồi đến bảng, rồi keyword |

Ngữ cảnh và các bảng trong phạm vi do [`dt-sql-parser`](https://github.com/DTStack/dt-sql-parser) xác định (chạy trong Web Worker, trên câu lệnh tại con trỏ), nên subquery, CTE và alias lồng nhau đều ra đúng cột. PostgreSQL dùng class `PostgreSQL`; thư viện không có dialect Oracle nên Oracle dùng `GenericSQL`. Khi parser không trả lời được (cú pháp riêng của Oracle, block PL/SQL, lần parse đầu quá 1,2 giây) thì bảng quy tắc regex ở trên trả lời thay. Hai hàm public `registerSqlCompletion(monaco)` và `metadataFor(model, getter)` giữ nguyên để `QueryWorkspace` không phải sửa.

---

## 9. Bảo mật

- Kestrel chỉ listen `IPAddress.Loopback`.
- Token 24 byte ngẫu nhiên mỗi lần chạy, inject vào WebView2. Web khác hoặc process khác trên máy không gọi được API.
- Password mã hoá bằng **DPAPI `CurrentUser`**: chỉ user Windows đó trên máy đó giải mã được. Nếu copy `connections.json` sang máy khác, password trả về rỗng và chỉ cần nhập lại.
- API không bao giờ trả password ra UI.
- Bản release tắt DevTools, context menu và phím tắt trình duyệt (`Ctrl+R`, `Ctrl+P`, `F5`...) trong WebView2.

---

## 10. Thêm một loại DB mới

**Relational có ADO.NET driver** (MySQL, SQL Server...):

1. Tạo `XxxProvider : AdoProviderBase` trong `DbStudio.Providers`.
2. Override `CreateConnection`, `MetadataSql`, và tuỳ chọn `PrepareSql`, `ReadValue`, `DescribeError`.
3. `MetadataSql` phải trả về đúng 5 cột theo thứ tự: `schema, table, object_type, column, data_type`, sắp theo schema, table, vị trí cột.
4. Thêm giá trị vào `DbKind` (C#) và `DbKind` / `KIND_LABEL` / `DEFAULT_PORT` (`web/src/types.ts`).
5. Đăng ký trong `ApiHost.Build`: `builder.Services.AddSingleton<IDbProvider, XxxProvider>();`
6. Thêm vào mảng `SUPPORTED` trong `ConnectionDialog.tsx`.

**Không quan hệ** (Mongo, Redis): implement thẳng `IDbProvider`. Kết quả vẫn trả về dạng `QueryResult` (cột + dòng) để dùng lại grid; riêng phần viewer đặc thù thì thêm endpoint và component riêng.

---

## 11. Lộ trình

Giờ ước tính cho 1 người, tính theo giờ làm thực tế.

### Giai đoạn 1: Khung app (15–20h) ✅ skeleton
- [x] Host exe + WebView2 + Kestrel + token
- [x] Quản lý connection, DPAPI, test connection
- [x] Monaco editor local, theme sáng/tối theo Windows
- [x] Icon app (`app.ico`, vẽ lại bằng `scripts/make-icon.ps1`)
- [x] Lưu kích thước/vị trí cửa sổ (`settings.json`)

### Giai đoạn 2: Query Postgres + Oracle (20–30h) 🟡 đã có khung
- [x] Chạy query, giới hạn dòng, cancel, đo thời gian
- [x] Result grid virtualized, copy ô (`Ctrl+C`)
- [x] Lỗi Postgres gạch đỏ đúng vị trí
- [x] Chạy câu lệnh tại con trỏ (tách statement theo `;`, xử lý chuỗi/comment/PL-SQL block)
- [x] Giữ session theo tab: transaction, `SET search_path`, `ALTER SESSION`, nút Commit/Rollback
- [x] Cảnh báo khi đóng tab còn transaction chưa commit
- [ ] Cảnh báo khi thoát app / xoá connection còn transaction chưa commit
- [x] Nhiều result set: chạy nhiều statement, mỗi câu một tab kết quả
- [ ] Mở `REF CURSOR` thành result set (Oracle `SYS_REFCURSOR`, Postgres `refcursor`)
- [x] Stream kết quả vào lưới (`POST /query/stream`, NDJSON) thay vì trả một lần
- [x] Nhiều tab editor cho cùng một connection

### Giai đoạn 3: Autocomplete chuẩn (25–40h)
- [x] `dt-sql-parser` cho PostgreSQL; Oracle dùng grammar generic (thư viện không có PL/SQL)
- [x] Subquery, CTE, alias lồng nhau (PostgreSQL qua parser; Oracle đọc cột subquery / CTE từ text)
- [ ] Gợi ý function/procedure/package (`pg_proc`, `ALL_PROCEDURES`, `ALL_ARGUMENTS`) — mới có sau `CALL` và sau `schema.`
- [x] Hover hiển thị kiểu cột; signature help khi gọi function (chưa có thủ tục trong package Oracle)
- [ ] Oracle: chọn thêm owner ngoài schema hiện tại; Postgres: load cột lười với DB lớn

### Giai đoạn 4: Object explorer (15–25h) 🟡 chờ thử với DB thật
- [x] Tree schema → bảng/view/function/sequence
- [x] Xem DDL (Oracle `DBMS_METADATA.GET_DDL`; Postgres tự dựng từ catalog)
- [x] Xem data nhanh, đếm dòng, index, constraint
- [ ] Trigger / RLS policy / grant trong DDL bảng Postgres; menu chuột phải, kéo thả tên vào editor

### Giai đoạn 5: MongoDB (20–30h)
- [x] `MongoDB.Driver`, tree database → collection
- [x] Find/aggregate bằng cú pháp mongo shell (đối số đọc bằng BSON reader), xem document dạng JSON/grid
- [x] Gợi ý field bằng `$sample` (~100 document), cache theo metadata của connection
- [x] Transaction (replica set / sharded cluster), import JSON / CSV / Excel vào collection
- [x] Chạy JavaScript (Jint nhúng, sandbox): biến, vòng lặp, hàm, `forEach` / `map`, `print`; chưa có `async` / `await`, `load()`

### Giai đoạn 6: Redis (12–20h)
- [x] `StackExchange.Redis`, tree key theo `:` dùng `SCAN` (không dùng `KEYS *`)
- [x] Viewer theo kiểu: string, hash, list, set, zset, stream; TTL; sửa / thêm / xoá phần tử ngay trong viewer
- [x] Redis Cluster (quét key trên mọi master)
- [x] Console lệnh thô (cú pháp redis-cli, mỗi dòng một lệnh)

### Giai đoạn 7: Hoàn thiện (15–25h)
- [x] Query history, snippet
- [x] Format SQL (`sql-formatter`)
- [x] Export CSV/Excel
- [x] Cảnh báo khi chạy `UPDATE/DELETE` không có `WHERE` trên connection màu đỏ (Production)

---

## 12. Xử lý sự cố

| Hiện tượng | Nguyên nhân / cách xử lý |
|---|---|
| Mở exe báo thiếu WebView2 | Cài Evergreen WebView2 Runtime từ link trong thông báo |
| Trang trắng ghi "UI is not built" | Chưa `npm run build` trước khi build host |
| `--dev` mở ra trang lỗi kết nối | Chưa chạy `npm run dev` (port 5173) |
| Oracle `ORA-00933` / `ORA-00911` | Câu SQL có ký tự lạ; với block PL/SQL nhớ bắt đầu bằng `BEGIN`/`DECLARE` |
| Oracle chỉ gợi ý bảng của user đang login | Đúng thiết kế hiện tại; xem giai đoạn 3 |
| Password trống sau khi đổi máy | DPAPI gắn với user + máy; nhập lại password |
| Ngày giờ lệch | `timestamptz` hiển thị theo giờ máy; `timestamp` (không timezone) giữ nguyên |
