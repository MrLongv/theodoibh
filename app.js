/* =========================================================
   QUẢN LÝ BÁN HÀNG TMĐT - APP.JS
   Bản chạy thật qua Cloudflare Worker + D1
   KHÔNG dùng localStorage để lưu data hàng hóa

   VIỆC CẦN SỬA TRƯỚC KHI CHẠY:
   Đổi API_BASE thành link Worker của bạn.

   Ví dụ:
   const API_BASE = "https://ban-hang-tmdt-api.hoalangiongxoai.workers.dev";
========================================================= */

(() => {
  "use strict";

  /* =========================================================
     CONFIG
  ========================================================= */

  const API_BASE = "https://ban-hang-tmdt-api.hoalangiongxoai.workers.dev";

  const LS = {
    session: "tmdt_real_session_v1",
  };

  const PAGE_SIZE = 50;

  const VIEW_INFO = {
    dashboardView: ["Tổng quan", "Theo dõi nhanh tình hình bán hàng và tồn kho"],
    productsView: ["Sản phẩm", "Quản lý mã sản phẩm, giá vốn, tồn kho và cảnh báo sắp hết"],
    importsView: ["Nhập hàng", "Tạo phiếu nhập, cộng tồn kho và cập nhật giá vốn trung bình"],
    salesView: ["Bán hàng", "Nhập đơn bán, trừ tồn kho và tính lợi nhuận"],
    stockView: ["Tồn kho", "Xem nhanh số lượng còn lại, giá vốn và giá trị tồn"],
    reportsView: ["Báo cáo", "Xem doanh thu, giá vốn và lợi nhuận"],
    historyView: ["Lịch sử", "Theo dõi nhập, bán, điều chỉnh tồn kho"],
    settingsView: ["Cài đặt", "Thiết lập thông tin cửa hàng"],
  };

  /* =========================================================
     STATE
  ========================================================= */

  const state = {
    token: "",
    currentUser: null,
    currentView: "dashboardView",

    products: [],
    imports: [],
    sales: [],
    stock: [],
    history: [],

    dashboard: null,
    report: null,

    settings: {
      storeName: "Cửa hàng của tôi",
      currency: "VND",
      costMethod: "AVG",
      defaultMinQty: 5,
    },

    productPage: 1,
    productTotal: 0,
    productPageSize: PAGE_SIZE,

    loadingCount: 0,
  };

  /* =========================================================
     DOM HELPERS
  ========================================================= */

  const $ = (id) => document.getElementById(id);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  function getVal(id) {
    return ($(id)?.value || "").trim();
  }

  function setVal(id, val) {
    const el = $(id);
    if (el) el.value = val ?? "";
  }

  function setText(id, val) {
    const el = $(id);
    if (el) el.textContent = val ?? "";
  }

  function show(id) {
    $(id)?.classList.remove("hidden");
  }

  function hide(id) {
    $(id)?.classList.add("hidden");
  }

  function esc(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function num(v) {
    if (v === null || v === undefined || v === "") return 0;
    const n = Number(String(v).replaceAll(",", "").replaceAll(" ", "").trim());
    return Number.isFinite(n) ? n : 0;
  }

  function money(v) {
    return Math.round(Number(v || 0)).toLocaleString("vi-VN");
  }

  function today() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${da}`;
  }

  function fmtDate(v) {
    if (!v) return "";
    const d = new Date(String(v).slice(0, 10) + "T00:00:00");
    if (Number.isNaN(d.getTime())) return v;
    return d.toLocaleDateString("vi-VN");
  }

  function fmtDateTime(v) {
    if (!v) return "";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return v;
    return d.toLocaleString("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
      hour12: false,
    });
  }

  function sku(v) {
    return String(v || "")
      .trim()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .toUpperCase()
      .replace(/\s+/g, "-")
      .replace(/[^A-Z0-9-_]/g, "")
      .replace(/-+/g, "-");
  }

  function toast(msg) {
    setText("toastMessage", msg);
    show("toast");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => hide("toast"), 2500);
  }

  function loading(on, text = "Đang xử lý...") {
    if (on) state.loadingCount += 1;
    else state.loadingCount = Math.max(0, state.loadingCount - 1);

    const overlay = $("loadingOverlay");
    if (!overlay) return;

    const label = overlay.querySelector("span");
    if (label) label.textContent = text;

    overlay.classList.toggle("hidden", state.loadingCount <= 0);
  }

  function closeAllModals() {
    $$(".modal").forEach((m) => m.classList.add("hidden"));
  }

  function openModal(id) {
    show(id);
  }

  function closeModal(id) {
    hide(id);
  }

  function apiBase() {
    return String(API_BASE || "").replace(/\/+$/, "");
  }

  function isApiConfigured() {
    return apiBase() && !apiBase().includes("YOUR-WORKER-URL");
  }

  /* =========================================================
     API
  ========================================================= */

  async function api(path, options = {}) {
    if (!isApiConfigured()) {
      throw new Error("Bạn chưa đổi API_BASE trong app.js thành link Worker thật.");
    }

    const method = options.method || "GET";
    const body = options.body;
    const auth = options.auth !== false;

    const headers = {
      "Content-Type": "application/json",
    };

    if (auth && state.token) {
      headers.Authorization = `Bearer ${state.token}`;
    }

    const res = await fetch(apiBase() + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    let data = null;
    const text = await res.text();

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {
        ok: false,
        message: text || "Response không phải JSON",
      };
    }

    if (res.status === 401) {
      clearSession();
      showLogin();
      throw new Error(data.message || "Phiên đăng nhập hết hạn.");
    }

    if (!res.ok || data.ok === false) {
      throw new Error(data.message || data.code || `HTTP ${res.status}`);
    }

    return data;
  }

  async function safeRun(fn, loadingText = "Đang xử lý...") {
    try {
      loading(true, loadingText);
      return await fn();
    } catch (err) {
      toast(err?.message || String(err));
      console.error(err);
      return null;
    } finally {
      loading(false);
    }
  }

  function buildQuery(params) {
    const q = new URLSearchParams();

    Object.entries(params || {}).forEach(([key, val]) => {
      if (val !== undefined && val !== null && String(val).trim() !== "") {
        q.set(key, String(val).trim());
      }
    });

    const s = q.toString();
    return s ? `?${s}` : "";
  }

  /* =========================================================
     SESSION / AUTH
  ========================================================= */

  function readSession() {
    try {
      const raw = localStorage.getItem(LS.session);
      if (!raw) return;
      const session = JSON.parse(raw);
      state.token = session.token || "";
      state.currentUser = session.user || null;
    } catch {
      clearSession();
    }
  }

  function saveSession(session) {
    localStorage.setItem(LS.session, JSON.stringify(session));
    state.token = session.token || "";
    state.currentUser = session.user || null;
  }

  function clearSession() {
    localStorage.removeItem(LS.session);
    state.token = "";
    state.currentUser = null;
  }

  async function login() {
    const username = getVal("loginUsername");
    const password = getVal("loginPassword");

    if (!username) {
      toast("Vui lòng nhập tài khoản");
      $("loginUsername")?.focus();
      return;
    }

    if (!password) {
      toast("Vui lòng nhập mật khẩu");
      $("loginPassword")?.focus();
      return;
    }

    const data = await safeRun(async () => {
      return await api("/api/login", {
        method: "POST",
        auth: false,
        body: { username, password },
      });
    }, "Đang đăng nhập...");

    if (!data) {
      show("loginError");
      return;
    }

    hide("loginError");

    saveSession({
      token: data.token,
      user: data.user,
      loginAt: new Date().toISOString(),
    });

    showApp();
    toast("Đăng nhập thành công");
  }

  function logout() {
    clearSession();
    showLogin();
    toast("Đã đăng xuất");
  }

  function showLogin() {
    show("loginScreen");
    hide("app");
  }

  function showApp() {
    hide("loginScreen");
    show("app");

    setText("currentUser", state.currentUser?.displayName || state.currentUser?.username || "Admin");
    setText("currentDate", new Date().toLocaleDateString("vi-VN"));

    switchView(state.currentView || "dashboardView");
    loadInitialData();
  }

  /* =========================================================
     NAVIGATION
  ========================================================= */

  function switchView(viewId) {
    if (!VIEW_INFO[viewId]) viewId = "dashboardView";

    state.currentView = viewId;

    $$(".view").forEach((v) => {
      v.classList.toggle("active", v.id === viewId);
    });

    $$(".menu-item").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === viewId);
    });

    setText("pageTitle", VIEW_INFO[viewId][0]);
    setText("pageSubtitle", VIEW_INFO[viewId][1]);

    $("sidebar")?.classList.remove("open");

    refreshCurrentView();
  }

  async function refreshCurrentView() {
    if (!state.token) return;

    if (state.currentView === "dashboardView") await loadDashboard();
    if (state.currentView === "productsView") await loadProducts();
    if (state.currentView === "importsView") await loadImports();
    if (state.currentView === "salesView") await loadSales();
    if (state.currentView === "stockView") await loadStock();
    if (state.currentView === "reportsView") await loadReport();
    if (state.currentView === "historyView") await loadHistory();
    if (state.currentView === "settingsView") await loadSettings();
  }

  async function loadInitialData() {
    if (!state.token) return;

    await safeRun(async () => {
      await Promise.all([
        loadSettings(false),
        loadDashboard(false),
        loadProducts(false),
        loadImports(false),
        loadSales(false),
        loadStock(false),
        loadHistory(false),
        loadReport(false),
      ]);

      renderAll();
    }, "Đang tải dữ liệu...");
  }

  /* =========================================================
     LOADERS
  ========================================================= */

  async function loadProducts(useLoading = true) {
    const run = async () => {
      const data = await api("/api/products" + buildQuery({
        q: getVal("productSearch"),
        category: getVal("categoryFilter"),
        stockStatus: getVal("stockStatusFilter"),
        page: state.productPage,
        pageSize: state.productPageSize,
      }));

      state.products = data.items || [];
      state.productTotal = data.total || 0;
      renderProducts();
    };

    if (useLoading) return await safeRun(run, "Đang tải sản phẩm...");
    return await run();
  }

  async function loadAllProductsForLookup() {
    const data = await api("/api/products" + buildQuery({
      page: 1,
      pageSize: 300,
    }));

    state.products = data.items || [];
    return state.products;
  }

  async function loadImports(useLoading = true) {
    const run = async () => {
      const data = await api("/api/imports" + buildQuery({
        q: getVal("importSearch"),
        from: getVal("importFromDate"),
        to: getVal("importToDate"),
      }));

      state.imports = data.items || [];
      renderImports();
    };

    if (useLoading) return await safeRun(run, "Đang tải phiếu nhập...");
    return await run();
  }

  async function loadSales(useLoading = true) {
    const run = async () => {
      const data = await api("/api/sales" + buildQuery({
        q: getVal("saleSearch"),
        platform: getVal("platformFilter"),
        from: getVal("saleFromDate"),
        to: getVal("saleToDate"),
      }));

      state.sales = data.items || [];
      renderSales();
    };

    if (useLoading) return await safeRun(run, "Đang tải đơn bán...");
    return await run();
  }

  async function loadStock(useLoading = true) {
    const run = async () => {
      const data = await api("/api/stock" + buildQuery({
        q: getVal("stockSearch"),
        stockStatus: getVal("stockViewFilter"),
      }));

      state.stock = data.items || [];
      renderStock();
    };

    if (useLoading) return await safeRun(run, "Đang tải tồn kho...");
    return await run();
  }

  async function loadHistory(useLoading = true) {
    const run = async () => {
      const data = await api("/api/history" + buildQuery({
        q: getVal("historySearch"),
        type: getVal("historyTypeFilter"),
        from: getVal("historyFromDate"),
        to: getVal("historyToDate"),
      }));

      state.history = data.items || [];
      renderHistory();
    };

    if (useLoading) return await safeRun(run, "Đang tải lịch sử...");
    return await run();
  }

  async function loadDashboard(useLoading = true) {
    const run = async () => {
      const data = await api("/api/dashboard");
      state.dashboard = data;
      renderDashboard();
    };

    if (useLoading) return await safeRun(run, "Đang tải tổng quan...");
    return await run();
  }

  async function loadReport(useLoading = true) {
    const run = async () => {
      const data = await api("/api/reports/profit" + buildQuery({
        from: getVal("reportFromDate"),
        to: getVal("reportToDate"),
        platform: getVal("reportPlatform"),
      }));

      state.report = data;
      renderReport();
    };

    if (useLoading) return await safeRun(run, "Đang tải báo cáo...");
    return await run();
  }

  async function loadSettings(useLoading = true) {
    const run = async () => {
      const data = await api("/api/settings");
      state.settings = {
        ...state.settings,
        ...(data.settings || {}),
      };
      renderSettings();
    };

    if (useLoading) return await safeRun(run, "Đang tải cài đặt...");
    return await run();
  }

  /* =========================================================
     PRODUCT HELPERS
  ========================================================= */

  function findProductLocalBySku(code) {
    const normalized = sku(code);

    return (
      state.products.find((p) => p.sku === normalized) ||
      state.stock.find((p) => p.sku === normalized) ||
      null
    );
  }

  function productStockStatus(p) {
    const q = Number(p.current_qty || 0);
    const min = Number(p.min_qty || 0);
    if (q <= 0) return "outStock";
    if (q <= min) return "lowStock";
    return "inStock";
  }

  function stockBadge(p) {
    const s = p.stock_status || productStockStatus(p);
    if (s === "outStock") return '<span class="badge danger">Hết hàng</span>';
    if (s === "lowStock") return '<span class="badge warning">Sắp hết</span>';
    return '<span class="badge success">Còn hàng</span>';
  }

  function statusBadge(status) {
    if (status === "PAUSED") return '<span class="badge warning">Tạm ngưng</span>';
    if (status === "HIDDEN") return '<span class="badge danger">Ẩn</span>';
    return '<span class="badge success">Đang bán</span>';
  }

  function historyBadge(type) {
    if (type === "IMPORT") return '<span class="badge success">Nhập</span>';
    if (type === "SALE") return '<span class="badge warning">Bán</span>';
    if (type === "ADJUST") return '<span class="badge info">Điều chỉnh</span>';
    if (type === "RETURN") return '<span class="badge success">Trả hàng</span>';
    return `<span class="badge info">${esc(type)}</span>`;
  }

  function normalizeProductFromForm() {
    return {
      sku: sku(getVal("p_sku")),
      name: getVal("p_name"),
      category: getVal("p_category"),
      unit: getVal("p_unit") || "Cái",
      min_qty: Math.max(0, Math.round(num(getVal("p_min_qty")))),
      status: getVal("p_status") || "ACTIVE",
      note: getVal("p_note"),
    };
  }

  /* =========================================================
     PRODUCTS
  ========================================================= */

  function renderProducts() {
    const body = $("productsTableBody");
    if (!body) return;

    const rows = state.products || [];
    const totalPage = Math.max(1, Math.ceil((state.productTotal || rows.length) / state.productPageSize));

    state.productPage = Math.min(Math.max(1, state.productPage), totalPage);

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="11">Chưa có sản phẩm.</td></tr>';
    } else {
      const start = (state.productPage - 1) * state.productPageSize;

      body.innerHTML = rows.map((p, i) => {
        const value = Number(p.current_qty || 0) * Number(p.avg_cost || 0);
        const st = productStockStatus(p);
        const stockClass = st === "outStock" ? "danger-text" : st === "lowStock" ? "warning-text" : "";

        return `
          <tr>
            <td>${start + i + 1}</td>
            <td><strong>${esc(p.sku)}</strong></td>
            <td>${esc(p.name)}</td>
            <td>${esc(p.category || "")}</td>
            <td>${esc(p.unit || "Cái")}</td>
            <td class="${stockClass}">${money(p.current_qty)}</td>
            <td>${money(p.avg_cost)}</td>
            <td>${money(value)}</td>
            <td>${money(p.min_qty)}</td>
            <td>${statusBadge(p.status)}</td>
            <td>
              <div class="row-actions">
                <button class="btn tiny" data-act="edit-product" data-id="${esc(p.id)}">Sửa</button>
                <button class="btn tiny light" data-act="history-product" data-id="${esc(p.id)}" data-sku="${esc(p.sku)}">Lịch sử</button>
              </div>
            </td>
          </tr>
        `;
      }).join("");
    }

    setText("productPageInfo", `Trang ${state.productPage} / ${totalPage}`);
  }

  function openProductModal(product = null) {
    hide("productDuplicateWarning");

    const modal = $("productModal");
    if (!modal) return;

    if (product) {
      modal.dataset.id = product.id;
      setText("productModalTitle", "Sửa sản phẩm");
      setVal("p_sku", product.sku);
      setVal("p_name", product.name);
      setVal("p_category", product.category || "");
      setVal("p_unit", product.unit || "Cái");
      setVal("p_min_qty", product.min_qty || 0);
      setVal("p_status", product.status || "ACTIVE");
      setVal("p_note", product.note || "");
    } else {
      delete modal.dataset.id;
      setText("productModalTitle", "Thêm sản phẩm");
      setVal("p_sku", "");
      setVal("p_name", "");
      setVal("p_category", "");
      setVal("p_unit", "Cái");
      setVal("p_min_qty", state.settings.defaultMinQty || 5);
      setVal("p_status", "ACTIVE");
      setVal("p_note", "");
    }

    openModal("productModal");
    setTimeout(() => $("p_sku")?.focus(), 50);
  }

  async function saveProduct() {
    const modal = $("productModal");
    const editId = modal?.dataset.id || "";
    const payload = normalizeProductFromForm();

    if (!payload.sku) {
      toast("Vui lòng nhập mã sản phẩm");
      $("p_sku")?.focus();
      return;
    }

    if (!payload.name) {
      toast("Vui lòng nhập tên sản phẩm");
      $("p_name")?.focus();
      return;
    }

    const data = await safeRun(async () => {
      if (editId) {
        return await api(`/api/products/${encodeURIComponent(editId)}`, {
          method: "PUT",
          body: payload,
        });
      }

      return await api("/api/products", {
        method: "POST",
        body: payload,
      });
    }, editId ? "Đang cập nhật sản phẩm..." : "Đang thêm sản phẩm...");

    if (!data) return;

    closeModal("productModal");
    toast(editId ? "Đã cập nhật sản phẩm" : "Đã thêm sản phẩm");

    await Promise.all([
      loadProducts(false),
      loadStock(false),
      loadDashboard(false),
    ]);
  }

  async function openEditProduct(productId) {
    const data = await safeRun(async () => {
      return await api(`/api/products/${encodeURIComponent(productId)}`);
    }, "Đang tải sản phẩm...");

    if (!data?.item) return;
    openProductModal(data.item);
  }

  /* =========================================================
     IMPORTS
  ========================================================= */

  function importCode() {
    const date = today().replaceAll("-", "");
    const rand = Math.floor(Math.random() * 9000 + 1000);
    return `PN-${date}-${rand}`;
  }

  function importLineHTML() {
    return `
      <tr>
        <td><input class="line-sku" type="text" placeholder="AO-0001" /></td>
        <td><input class="line-name" type="text" disabled /></td>
        <td><input class="line-qty" type="number" min="1" value="1" /></td>
        <td><input class="line-cost" type="number" min="0" placeholder="0" /></td>
        <td><input class="line-total" type="text" value="0" disabled /></td>
        <td><button class="btn tiny danger" type="button" data-act="remove-import-line">Xóa</button></td>
      </tr>
    `;
  }

  async function openImportModal() {
    if (!state.products.length && !state.stock.length) {
      await safeRun(async () => {
        await loadAllProductsForLookup();
        await loadStock(false);
      }, "Đang tải sản phẩm...");
    }

    setVal("i_date", today());
    setVal("i_supplier", "");
    setVal("i_code", importCode());
    setVal("i_note", "");

    const body = $("importLinesBody");
    if (body) body.innerHTML = importLineHTML();

    updateImportTotal();
    openModal("importModal");
  }

  function updateImportRow(row) {
    if (!row) return;

    const skuInput = row.querySelector(".line-sku");
    const nameInput = row.querySelector(".line-name");
    const qtyInput = row.querySelector(".line-qty");
    const costInput = row.querySelector(".line-cost");
    const totalInput = row.querySelector(".line-total");

    const code = sku(skuInput?.value || "");
    if (skuInput && skuInput.value !== code) skuInput.value = code;

    const p = findProductLocalBySku(code);

    if (nameInput) {
      nameInput.value = code ? (p ? p.name : "Không tìm thấy mã") : "";
    }

    const q = num(qtyInput?.value);
    const c = num(costInput?.value);

    if (totalInput) totalInput.value = money(q * c);
  }

  function updateImportTotal() {
    let total = 0;

    $$("#importLinesBody tr").forEach((row) => {
      updateImportRow(row);
      total += num(row.querySelector(".line-qty")?.value) * num(row.querySelector(".line-cost")?.value);
    });

    setText("importTotalAmount", money(total));
  }

  function collectImportLines() {
    const lines = [];

    $$("#importLinesBody tr").forEach((row) => {
      const code = sku(row.querySelector(".line-sku")?.value || "");
      const qty = Math.round(num(row.querySelector(".line-qty")?.value));
      const unitCost = Math.round(num(row.querySelector(".line-cost")?.value));

      if (!code && !qty && !unitCost) return;

      lines.push({
        row,
        sku: code,
        qty,
        unit_cost: unitCost,
      });
    });

    return lines;
  }

  async function saveImport() {
    const code = getVal("i_code") || importCode();
    const date = getVal("i_date") || today();
    const supplier = getVal("i_supplier");
    const note = getVal("i_note");
    const lines = collectImportLines();

    if (!lines.length) {
      toast("Vui lòng nhập ít nhất 1 dòng hàng");
      return;
    }

    for (const line of lines) {
      if (!line.sku) {
        toast("Có dòng chưa nhập mã sản phẩm");
        line.row.querySelector(".line-sku")?.focus();
        return;
      }

      if (line.qty <= 0) {
        toast(`Số lượng nhập của ${line.sku} phải lớn hơn 0`);
        line.row.querySelector(".line-qty")?.focus();
        return;
      }

      if (line.unit_cost < 0) {
        toast(`Giá nhập của ${line.sku} không hợp lệ`);
        line.row.querySelector(".line-cost")?.focus();
        return;
      }
    }

    const data = await safeRun(async () => {
      return await api("/api/imports", {
        method: "POST",
        body: {
          code,
          date,
          supplier,
          note,
          lines: lines.map((x) => ({
            sku: x.sku,
            qty: x.qty,
            unit_cost: x.unit_cost,
          })),
        },
      });
    }, "Đang lưu phiếu nhập...");

    if (!data) return;

    closeModal("importModal");
    toast("Đã nhập hàng và cập nhật tồn kho");

    await Promise.all([
      loadImports(false),
      loadProducts(false),
      loadStock(false),
      loadHistory(false),
      loadDashboard(false),
    ]);
  }

  function renderImports() {
    const body = $("importsTableBody");
    if (!body) return;

    const rows = state.imports || [];

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="9">Chưa có phiếu nhập.</td></tr>';
      return;
    }

    body.innerHTML = rows.map((x) => `
      <tr>
        <td>${fmtDate(x.date)}</td>
        <td><strong>${esc(x.code)}</strong></td>
        <td>${esc(x.supplier || "")}</td>
        <td>${esc(x.line_count ?? "")}</td>
        <td>${money(x.total_qty)}</td>
        <td>${money(x.total_amount)}</td>
        <td>${esc(x.created_by || "")}</td>
        <td>${esc(x.note || "")}</td>
        <td><button class="btn tiny" data-act="view-import" data-id="${esc(x.id)}">Chi tiết</button></td>
      </tr>
    `).join("");
  }

  async function viewImport(id) {
    const data = await safeRun(async () => {
      return await api(`/api/imports/${encodeURIComponent(id)}`);
    }, "Đang tải chi tiết phiếu nhập...");

    const x = data?.item;
    if (!x) return;

    const lines = (x.lines || []).map((l) =>
      `- ${l.sku} | ${l.name} | SL: ${money(l.qty)} | Giá: ${money(l.unit_cost)} | Tiền: ${money(l.total_cost)}`
    ).join("\n");

    alert(
      `PHIẾU NHẬP: ${x.code}\n` +
      `Ngày: ${fmtDate(x.date)}\n` +
      `Nhà cung cấp: ${x.supplier || ""}\n` +
      `Tổng SL: ${money(x.total_qty)}\n` +
      `Tổng tiền: ${money(x.total_amount)}\n\n` +
      `${lines}`
    );
  }

  /* =========================================================
     SALES
  ========================================================= */

  function saleLineHTML() {
    return `
      <tr>
        <td><input class="sale-sku" type="text" placeholder="AO-0001" /></td>
        <td><input class="sale-name" type="text" disabled /></td>
        <td><input class="sale-stock" type="text" disabled /></td>
        <td><input class="sale-qty" type="number" min="1" value="1" /></td>
        <td><input class="sale-price" type="number" min="0" placeholder="0" /></td>
        <td><input class="sale-cost" type="text" disabled /></td>
        <td><input class="sale-profit" type="text" disabled /></td>
        <td><button class="btn tiny danger" type="button" data-act="remove-sale-line">Xóa</button></td>
      </tr>
    `;
  }

  async function openSaleModal() {
    if (!state.products.length && !state.stock.length) {
      await safeRun(async () => {
        await loadAllProductsForLookup();
        await loadStock(false);
      }, "Đang tải sản phẩm...");
    }

    setVal("s_date", today());
    setVal("s_platform", "Shopee");
    setVal("s_order_code", "");
    setVal("s_note", "");
    setVal("s_gross_amount", 0);
    setVal("s_platform_fee", 0);
    setVal("s_discount", 0);
    setVal("s_other_fee", 0);
    setVal("s_net_amount", 0);

    hide("saleDuplicateWarning");

    const body = $("saleLinesBody");
    if (body) body.innerHTML = saleLineHTML();

    updateSaleTotal(true);
    openModal("saleModal");
  }

  function updateSaleRow(row) {
    if (!row) return;

    const skuInput = row.querySelector(".sale-sku");
    const nameInput = row.querySelector(".sale-name");
    const stockInput = row.querySelector(".sale-stock");
    const qtyInput = row.querySelector(".sale-qty");
    const priceInput = row.querySelector(".sale-price");
    const costInput = row.querySelector(".sale-cost");
    const profitInput = row.querySelector(".sale-profit");

    const code = sku(skuInput?.value || "");
    if (skuInput && skuInput.value !== code) skuInput.value = code;

    const p = findProductLocalBySku(code);
    const q = num(qtyInput?.value);
    const price = num(priceInput?.value);

    if (nameInput) nameInput.value = code ? (p ? p.name : "Không tìm thấy mã") : "";
    if (stockInput) stockInput.value = p ? money(p.current_qty) : "";
    if (costInput) costInput.value = p ? money(p.avg_cost) : "";
    if (profitInput) profitInput.value = p ? money((q * price) - (q * Number(p.avg_cost || 0))) : "";
  }

  function updateSaleTotal(autoNet = true) {
    let gross = 0;
    let cost = 0;

    $$("#saleLinesBody tr").forEach((row) => {
      updateSaleRow(row);

      const code = sku(row.querySelector(".sale-sku")?.value || "");
      const p = findProductLocalBySku(code);
      const q = num(row.querySelector(".sale-qty")?.value);
      const price = num(row.querySelector(".sale-price")?.value);

      gross += q * price;
      if (p) cost += q * Number(p.avg_cost || 0);
    });

    setVal("s_gross_amount", Math.round(gross));

    if (autoNet) {
      const fee = num(getVal("s_platform_fee")) + num(getVal("s_discount")) + num(getVal("s_other_fee"));
      setVal("s_net_amount", Math.max(0, Math.round(gross - fee)));
    }

    const net = num(getVal("s_net_amount"));
    setText("saleCostAmount", money(cost));
    setText("saleProfitAmount", money(net - cost));

    return {
      gross,
      cost,
      net,
      profit: net - cost,
    };
  }

  function collectSaleLines() {
    const lines = [];

    $$("#saleLinesBody tr").forEach((row) => {
      const code = sku(row.querySelector(".sale-sku")?.value || "");
      const qty = Math.round(num(row.querySelector(".sale-qty")?.value));
      const unitPrice = Math.round(num(row.querySelector(".sale-price")?.value));

      if (!code && !qty && !unitPrice) return;

      lines.push({
        row,
        sku: code,
        qty,
        unit_price: unitPrice,
      });
    });

    return lines;
  }

  async function saveSale() {
    const orderCode = getVal("s_order_code");
    const platform = getVal("s_platform") || "Khác";
    const date = getVal("s_date") || today();
    const note = getVal("s_note");

    if (!orderCode) {
      toast("Vui lòng nhập mã đơn");
      $("s_order_code")?.focus();
      return;
    }

    const lines = collectSaleLines();

    if (!lines.length) {
      toast("Vui lòng nhập ít nhất 1 sản phẩm bán");
      return;
    }

    for (const line of lines) {
      const p = findProductLocalBySku(line.sku);

      if (!line.sku) {
        toast("Có dòng chưa nhập mã sản phẩm");
        line.row.querySelector(".sale-sku")?.focus();
        return;
      }

      if (!p) {
        toast(`Không tìm thấy mã: ${line.sku}`);
        line.row.querySelector(".sale-sku")?.focus();
        return;
      }

      if (line.qty <= 0) {
        toast(`Số lượng bán của ${line.sku} phải lớn hơn 0`);
        line.row.querySelector(".sale-qty")?.focus();
        return;
      }

      if (line.qty > Number(p.current_qty || 0)) {
        toast(`${line.sku} không đủ tồn`);
        line.row.querySelector(".sale-qty")?.focus();
        return;
      }

      if (line.unit_price < 0) {
        toast(`Giá bán của ${line.sku} không hợp lệ`);
        line.row.querySelector(".sale-price")?.focus();
        return;
      }
    }

    const totals = updateSaleTotal(false);

    const data = await safeRun(async () => {
      return await api("/api/sales", {
        method: "POST",
        body: {
          order_code: orderCode,
          platform,
          date,
          note,
          platform_fee: Math.round(num(getVal("s_platform_fee"))),
          discount: Math.round(num(getVal("s_discount"))),
          other_fee: Math.round(num(getVal("s_other_fee"))),
          net_amount: Math.round(num(getVal("s_net_amount")) || totals.net),
          lines: lines.map((x) => ({
            sku: x.sku,
            qty: x.qty,
            unit_price: x.unit_price,
          })),
        },
      });
    }, "Đang lưu đơn bán...");

    if (!data) return;

    closeModal("saleModal");
    toast("Đã lưu đơn bán và trừ tồn kho");

    await Promise.all([
      loadSales(false),
      loadProducts(false),
      loadStock(false),
      loadHistory(false),
      loadDashboard(false),
      loadReport(false),
    ]);
  }

  function renderSales() {
    const body = $("salesTableBody");
    if (!body) return;

    const rows = state.sales || [];

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="10">Chưa có đơn bán.</td></tr>';
      return;
    }

    body.innerHTML = rows.map((x) => {
      const fee = Number(x.platform_fee || 0) + Number(x.discount || 0) + Number(x.other_fee || 0);

      return `
        <tr>
          <td>${fmtDate(x.date)}</td>
          <td>${esc(x.platform)}</td>
          <td><strong>${esc(x.order_code)}</strong></td>
          <td>${money(x.gross_amount)}</td>
          <td>${money(fee)}</td>
          <td>${money(x.net_amount)}</td>
          <td>${money(x.cost_amount)}</td>
          <td class="${Number(x.profit || 0) >= 0 ? "positive-text" : "negative-text"}">${money(x.profit)}</td>
          <td>${esc(x.created_by || "")}</td>
          <td><button class="btn tiny" data-act="view-sale" data-id="${esc(x.id)}">Chi tiết</button></td>
        </tr>
      `;
    }).join("");
  }

  async function viewSale(id) {
    const data = await safeRun(async () => {
      return await api(`/api/sales/${encodeURIComponent(id)}`);
    }, "Đang tải chi tiết đơn bán...");

    const x = data?.item;
    if (!x) return;

    const lines = (x.lines || []).map((l) =>
      `- ${l.sku} | ${l.name} | SL: ${money(l.qty)} | Bán: ${money(l.unit_price)} | Vốn: ${money(l.cost_at_sale)}`
    ).join("\n");

    alert(
      `ĐƠN BÁN: ${x.order_code}\n` +
      `Ngày: ${fmtDate(x.date)}\n` +
      `Sàn: ${x.platform}\n` +
      `Doanh thu: ${money(x.gross_amount)}\n` +
      `Thực nhận: ${money(x.net_amount)}\n` +
      `Giá vốn: ${money(x.cost_amount)}\n` +
      `Lợi nhuận: ${money(x.profit)}\n\n` +
      `${lines}`
    );
  }

  /* =========================================================
     STOCK
  ========================================================= */

  function renderStock() {
    const body = $("stockTableBody");
    if (!body) return;

    const rows = state.stock || [];

    const inCount = rows.filter((p) => (p.stock_status || productStockStatus(p)) === "inStock").length;
    const lowCount = rows.filter((p) => (p.stock_status || productStockStatus(p)) === "lowStock").length;
    const outCount = rows.filter((p) => (p.stock_status || productStockStatus(p)) === "outStock").length;
    const totalValue = rows.reduce((s, p) => s + Number(p.current_qty || 0) * Number(p.avg_cost || 0), 0);

    setText("stockInCount", inCount);
    setText("stockLowCount", lowCount);
    setText("stockOutCount", outCount);
    setText("stockTotalValue", money(totalValue));

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7">Chưa có tồn kho.</td></tr>';
      return;
    }

    body.innerHTML = rows.map((p) => `
      <tr>
        <td><strong>${esc(p.sku)}</strong></td>
        <td>${esc(p.name)}</td>
        <td>${money(p.current_qty)}</td>
        <td>${money(p.avg_cost)}</td>
        <td>${money(Number(p.current_qty || 0) * Number(p.avg_cost || 0))}</td>
        <td>${money(p.min_qty)}</td>
        <td>${stockBadge(p)}</td>
      </tr>
    `).join("");
  }

  function openAdjustModal() {
    setVal("a_sku", "");
    setVal("a_current_qty", "");
    setVal("a_type", "PLUS");
    setVal("a_qty", 0);
    setVal("a_note", "");
    openModal("stockAdjustModal");
  }

  function updateAdjustQty() {
    const code = sku(getVal("a_sku"));
    setVal("a_sku", code);

    const p = findProductLocalBySku(code);
    setVal("a_current_qty", p ? money(p.current_qty) : "");
  }

  async function saveAdjust() {
    const code = sku(getVal("a_sku"));
    const type = getVal("a_type");
    const qty = Math.round(num(getVal("a_qty")));
    const note = getVal("a_note");

    if (!code) {
      toast("Vui lòng nhập mã sản phẩm");
      $("a_sku")?.focus();
      return;
    }

    if (qty < 0) {
      toast("Số lượng điều chỉnh không hợp lệ");
      $("a_qty")?.focus();
      return;
    }

    const data = await safeRun(async () => {
      return await api("/api/stock/adjust", {
        method: "POST",
        body: {
          sku: code,
          type,
          qty,
          note,
        },
      });
    }, "Đang điều chỉnh tồn kho...");

    if (!data) return;

    closeModal("stockAdjustModal");
    toast("Đã điều chỉnh tồn kho");

    await Promise.all([
      loadProducts(false),
      loadStock(false),
      loadHistory(false),
      loadDashboard(false),
    ]);
  }

  /* =========================================================
     DASHBOARD
  ========================================================= */

  function renderDashboard() {
    const data = state.dashboard || {};
    const stats = data.stats || {};

    setText("statProducts", money(stats.total_products || 0));
    setText("statStockQty", money(stats.total_qty || 0));
    setText("statStockValue", money(stats.stock_value || 0));
    setText("statMonthlyProfit", money(stats.month_profit || 0));

    const lowBody = $("lowStockBody");
    if (lowBody) {
      const low = data.lowStock || [];

      lowBody.innerHTML = low.length ? low.map((p) => `
        <tr>
          <td><strong>${esc(p.sku)}</strong></td>
          <td>${esc(p.name)}</td>
          <td>${money(p.current_qty)}</td>
          <td>${money(p.min_qty)}</td>
          <td>${stockBadge(p)}</td>
        </tr>
      `).join("") : '<tr><td colspan="5">Chưa có hàng sắp hết.</td></tr>';
    }

    const recent = $("recentSalesList");
    if (recent) {
      const rows = data.recentSales || [];

      recent.innerHTML = rows.length ? rows.map((s) => `
        <div class="activity-item">
          <div>
            <strong>${esc(s.platform)} · ${esc(s.order_code)}</strong>
            <p>${fmtDate(s.date)} · Thực nhận: ${money(s.net_amount)}</p>
          </div>
          <span class="money ${Number(s.profit || 0) >= 0 ? "positive" : ""}">
            ${Number(s.profit || 0) >= 0 ? "+" : ""}${money(s.profit)}
          </span>
        </div>
      `).join("") : '<div class="activity-item"><div><strong>Chưa có đơn bán</strong><p>Nhập đơn bán đầu tiên</p></div></div>';
    }
  }

  /* =========================================================
     REPORT
  ========================================================= */

  function renderReport() {
    const data = state.report || {};
    const totals = data.totals || {};

    setText("reportRevenue", money(totals.gross_amount || 0));
    setText("reportNet", money(totals.net_amount || 0));
    setText("reportCost", money(totals.cost_amount || 0));
    setText("reportProfit", money(totals.profit || 0));

    const pBody = $("platformReportBody");
    if (pBody) {
      const rows = data.byPlatform || [];

      pBody.innerHTML = rows.length ? rows.map((r) => `
        <tr>
          <td>${esc(r.platform)}</td>
          <td>${money(r.orders)}</td>
          <td>${money(r.net_amount)}</td>
          <td>${money(r.cost_amount)}</td>
          <td class="${Number(r.profit || 0) >= 0 ? "positive-text" : "negative-text"}">${money(r.profit)}</td>
        </tr>
      `).join("") : '<tr><td colspan="5">Chưa có dữ liệu.</td></tr>';
    }

    const tBody = $("topProductReportBody");
    if (tBody) {
      const rows = data.topProducts || [];

      tBody.innerHTML = rows.length ? rows.map((r) => `
        <tr>
          <td><strong>${esc(r.sku)}</strong></td>
          <td>${esc(r.name)}</td>
          <td>${money(r.qty)}</td>
          <td class="${Number(r.profit || 0) >= 0 ? "positive-text" : "negative-text"}">${money(r.profit)}</td>
        </tr>
      `).join("") : '<tr><td colspan="4">Chưa có dữ liệu.</td></tr>';
    }
  }

  /* =========================================================
     HISTORY
  ========================================================= */

  function renderHistory() {
    const body = $("historyTableBody");
    if (!body) return;

    const rows = state.history || [];

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="9">Chưa có lịch sử.</td></tr>';
      return;
    }

    body.innerHTML = rows.map((h) => {
      const change = Number(h.qty_change || 0);

      return `
        <tr>
          <td>${fmtDateTime(h.created_at)}</td>
          <td><strong>${esc(h.sku)}</strong></td>
          <td>${historyBadge(h.type)}</td>
          <td class="${change >= 0 ? "positive-text" : "negative-text"}">${change >= 0 ? "+" : ""}${money(change)}</td>
          <td>${money(h.qty_before)}</td>
          <td>${money(h.qty_after)}</td>
          <td>${esc(h.ref_code || "")}</td>
          <td>${esc(h.created_by || "")}</td>
          <td>${esc(h.note || "")}</td>
        </tr>
      `;
    }).join("");
  }

  /* =========================================================
     SETTINGS
  ========================================================= */

  function renderSettings() {
    setVal("settingStoreName", state.settings.storeName || "Cửa hàng của tôi");
    setVal("settingCurrency", state.settings.currency || "VND");
    setVal("settingCostMethod", state.settings.costMethod || "AVG");
    setVal("settingDefaultMinQty", state.settings.defaultMinQty || 5);
  }

  async function saveSettings() {
    const payload = {
      storeName: getVal("settingStoreName") || "Cửa hàng của tôi",
      currency: getVal("settingCurrency") || "VND",
      costMethod: getVal("settingCostMethod") || "AVG",
      defaultMinQty: Math.max(0, Math.round(num(getVal("settingDefaultMinQty")))),
    };

    const data = await safeRun(async () => {
      return await api("/api/settings", {
        method: "PUT",
        body: payload,
      });
    }, "Đang lưu cài đặt...");

    if (!data) return;

    state.settings = {
      ...state.settings,
      ...(data.settings || payload),
    };

    renderSettings();
    toast("Đã lưu cài đặt");
  }

  /* =========================================================
     EXPORT CSV
  ========================================================= */

  function csvCell(v) {
    return '"' + String(v ?? "").replaceAll('"', '""') + '"';
  }

  function downloadCsv(name, rows) {
    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\n");
    const blob = new Blob(["\ufeff" + csv], {
      type: "text/csv;charset=utf-8",
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");

    a.href = url;
    a.download = name;

    document.body.appendChild(a);
    a.click();
    a.remove();

    URL.revokeObjectURL(url);
  }

  function exportProducts() {
    const rows = [[
      "STT", "Mã SP", "Tên", "Nhóm", "ĐVT",
      "Tồn", "Giá vốn TB", "Giá trị tồn", "Cảnh báo", "Trạng thái"
    ]];

    (state.products || []).forEach((p, i) => rows.push([
      i + 1,
      p.sku,
      p.name,
      p.category,
      p.unit,
      p.current_qty,
      p.avg_cost,
      Number(p.current_qty || 0) * Number(p.avg_cost || 0),
      p.min_qty,
      p.status,
    ]));

    downloadCsv("san-pham-" + today() + ".csv", rows);
  }

  function exportStock() {
    const rows = [[
      "STT", "Mã SP", "Tên", "Tồn", "Giá vốn TB", "Giá trị tồn", "Cảnh báo", "Tình trạng"
    ]];

    (state.stock || []).forEach((p, i) => rows.push([
      i + 1,
      p.sku,
      p.name,
      p.current_qty,
      p.avg_cost,
      Number(p.current_qty || 0) * Number(p.avg_cost || 0),
      p.min_qty,
      p.stock_status || productStockStatus(p),
    ]));

    downloadCsv("ton-kho-" + today() + ".csv", rows);
  }

  function exportImports() {
    const rows = [[
      "Ngày", "Mã phiếu", "Nhà cung cấp", "Tổng SL", "Tổng tiền", "Người nhập", "Ghi chú"
    ]];

    (state.imports || []).forEach((x) => rows.push([
      x.date,
      x.code,
      x.supplier,
      x.total_qty,
      x.total_amount,
      x.created_by,
      x.note,
    ]));

    downloadCsv("nhap-hang-" + today() + ".csv", rows);
  }

  function exportSales() {
    const rows = [[
      "Ngày", "Sàn", "Mã đơn", "Doanh thu", "Phí sàn", "Giảm giá", "Phí khác",
      "Thực nhận", "Giá vốn", "Lợi nhuận", "Người nhập", "Ghi chú"
    ]];

    (state.sales || []).forEach((s) => rows.push([
      s.date,
      s.platform,
      s.order_code,
      s.gross_amount,
      s.platform_fee,
      s.discount,
      s.other_fee,
      s.net_amount,
      s.cost_amount,
      s.profit,
      s.created_by,
      s.note,
    ]));

    downloadCsv("ban-hang-" + today() + ".csv", rows);
  }

  function exportHistory() {
    const rows = [[
      "Thời gian", "Mã SP", "Tên", "Loại", "Thay đổi", "Trước", "Sau",
      "Tham chiếu", "Người thao tác", "Ghi chú"
    ]];

    (state.history || []).forEach((h) => rows.push([
      fmtDateTime(h.created_at),
      h.sku,
      h.name,
      h.type,
      h.qty_change,
      h.qty_before,
      h.qty_after,
      h.ref_code,
      h.created_by,
      h.note,
    ]));

    downloadCsv("lich-su-" + today() + ".csv", rows);
  }

  function exportReport() {
    const data = state.report || {};
    const totals = data.totals || {};

    const rows = [
      ["BÁO CÁO LỢI NHUẬN"],
      ["Từ ngày", getVal("reportFromDate")],
      ["Đến ngày", getVal("reportToDate")],
      ["Sàn", getVal("reportPlatform") || "Tất cả"],
      [],
      ["Tổng đơn", "Doanh thu", "Thực nhận", "Giá vốn", "Lợi nhuận"],
      [
        totals.orders || 0,
        totals.gross_amount || 0,
        totals.net_amount || 0,
        totals.cost_amount || 0,
        totals.profit || 0,
      ],
      [],
      ["Theo sàn"],
      ["Sàn", "Số đơn", "Thực nhận", "Giá vốn", "Lợi nhuận"],
    ];

    (data.byPlatform || []).forEach((r) => rows.push([
      r.platform,
      r.orders,
      r.net_amount,
      r.cost_amount,
      r.profit,
    ]));

    rows.push([]);
    rows.push(["Sản phẩm bán chạy"]);
    rows.push(["Mã SP", "Tên", "SL bán", "Doanh thu", "Giá vốn", "Lợi nhuận"]);

    (data.topProducts || []).forEach((r) => rows.push([
      r.sku,
      r.name,
      r.qty,
      r.revenue,
      r.cost_amount,
      r.profit,
    ]));

    downloadCsv("bao-cao-" + today() + ".csv", rows);
  }


  /* =========================================================
     IMPORT EXCEL - PRODUCTS
     Đọc sheet 01_SanPham trong file Excel mẫu.
     Cần internet để tải SheetJS từ CDN khi bấm nút lần đầu.
  ========================================================= */

  function loadXlsxLibrary() {
    return new Promise((resolve, reject) => {
      if (window.XLSX) {
        resolve(window.XLSX);
        return;
      }

      const existed = document.querySelector('script[data-xlsx-loader="1"]');
      if (existed) {
        existed.addEventListener("load", () => resolve(window.XLSX));
        existed.addEventListener("error", () => reject(new Error("Không tải được thư viện đọc Excel.")));
        return;
      }

      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      script.async = true;
      script.dataset.xlsxLoader = "1";

      script.onload = () => {
        if (window.XLSX) resolve(window.XLSX);
        else reject(new Error("Thư viện đọc Excel chưa sẵn sàng."));
      };

      script.onerror = () => {
        reject(new Error("Không tải được thư viện đọc Excel. Kiểm tra internet hoặc CDN."));
      };

      document.head.appendChild(script);
    });
  }

  function pickExcelFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".xlsx,.xls,.csv";

      input.onchange = () => {
        resolve(input.files?.[0] || null);
      };

      input.click();
    });
  }

  function normalizeHeaderName(value) {
    return String(value || "")
      .trim()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function readAnyField(row, names) {
    const normalized = {};

    Object.keys(row || {}).forEach((key) => {
      normalized[normalizeHeaderName(key)] = row[key];
    });

    for (const name of names) {
      const key = normalizeHeaderName(name);
      if (normalized[key] !== undefined && normalized[key] !== null) {
        return normalized[key];
      }
    }

    return "";
  }

  async function readProductsFromExcel(file) {
    const XLSX = await loadXlsxLibrary();
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });

    const sheetName =
      workbook.SheetNames.find((name) => normalizeHeaderName(name) === "01_sanpham") ||
      workbook.SheetNames.find((name) => normalizeHeaderName(name).includes("sanpham")) ||
      workbook.SheetNames[0];

    if (!sheetName) {
      throw new Error("File Excel không có sheet dữ liệu.");
    }

    const sheet = workbook.Sheets[sheetName];

    /*
      File mẫu có 3 dòng tiêu đề/hướng dẫn phía trên.
      Header thật nằm ở dòng 4:
      sku * | name * | category | unit | min_qty | status | note

      Vì vậy không dùng sheet_to_json mặc định nữa.
      Ta đọc dạng mảng, tự dò dòng header có cột SKU và NAME.
    */
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
      raw: false,
      blankrows: false,
    });

    const isSkuHeader = (v) => {
      const h = normalizeHeaderName(v);
      return [
        "sku",
        "sku_",
        "ma_sp",
        "ma_san_pham",
        "ma_hang",
        "msp",
        "code",
        "product_code",
      ].includes(h);
    };

    const isNameHeader = (v) => {
      const h = normalizeHeaderName(v);
      return [
        "name",
        "name_",
        "ten",
        "ten_sp",
        "ten_san_pham",
        "ten_hang",
        "product_name",
      ].includes(h);
    };

    let headerRowIndex = -1;

    for (let i = 0; i < rows.length; i++) {
      const line = rows[i] || [];
      const hasSku = line.some(isSkuHeader);
      const hasName = line.some(isNameHeader);

      if (hasSku && hasName) {
        headerRowIndex = i;
        break;
      }
    }

    if (headerRowIndex < 0) {
      throw new Error("Không tìm thấy dòng tiêu đề sản phẩm. File cần có cột sku * và name *.");
    }

    const headers = (rows[headerRowIndex] || []).map(normalizeHeaderName);

    function valueAt(line, names) {
      const wanted = names.map(normalizeHeaderName);

      for (let i = 0; i < headers.length; i++) {
        if (wanted.includes(headers[i])) {
          return line[i];
        }
      }

      return "";
    }

    const products = [];

    for (let i = headerRowIndex + 1; i < rows.length; i++) {
      const line = rows[i] || [];

      const code = sku(valueAt(line, [
        "sku",
        "sku *",
        "ma_sp",
        "mã sp",
        "ma_san_pham",
        "mã sản phẩm",
        "ma_hang",
        "mã hàng",
        "code",
      ]));

      const name = String(valueAt(line, [
        "name",
        "name *",
        "ten",
        "ten_sp",
        "ten_san_pham",
        "tên sản phẩm",
        "ten_hang",
        "tên hàng",
        "product_name",
      ]) || "").trim();

      const category = String(valueAt(line, [
        "category",
        "nhom",
        "nhom_hang",
        "nhóm hàng",
        "loai",
        "loại",
      ]) || "").trim();

      const unit = String(valueAt(line, [
        "unit",
        "dvt",
        "don_vi",
        "đơn vị",
        "don_vi_tinh",
        "đơn vị tính",
      ]) || "Cái").trim() || "Cái";

      const minQty = Math.max(0, Math.round(num(valueAt(line, [
        "min_qty",
        "canh_bao",
        "ton_canh_bao",
        "tồn cảnh báo",
        "muc_canh_bao",
        "mức cảnh báo",
      ])) || 0));

      const statusRaw = String(valueAt(line, [
        "status",
        "trang_thai",
        "trạng thái",
      ]) || "ACTIVE").trim();

      const note = String(valueAt(line, [
        "note",
        "ghi_chu",
        "ghi chú",
      ]) || "").trim();

      if (!code && !name) continue;

      /*
        Tránh nhập nhầm 3 dòng ví dụ trong file mẫu nếu người dùng chưa xóa.
      */
      const isTemplateExample =
        note.toLowerCase().includes("ví dụ") ||
        note.toLowerCase().includes("vi du");

      if (isTemplateExample && [
        "AO-0001-DEN-M",
        "PK-0002",
        "GD-0011",
      ].includes(code)) {
        continue;
      }

      if (!code || !name) {
        throw new Error(`Dòng ${i + 1}: thiếu mã sản phẩm hoặc tên sản phẩm.`);
      }

      let status = statusRaw
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .toUpperCase()
        .trim();

      if (["DANG BAN", "ACTIVE", "A"].includes(status)) status = "ACTIVE";
      else if (["TAM NGUNG", "PAUSED", "P"].includes(status)) status = "PAUSED";
      else if (["AN", "HIDDEN", "H"].includes(status)) status = "HIDDEN";
      else status = "ACTIVE";

      products.push({
        sku: code,
        name,
        category,
        unit,
        min_qty: minQty || Number(state.settings.defaultMinQty || 5),
        status,
        note,
      });
    }

    return products;
  }


  async function importProductsExcel() {
    const file = await pickExcelFile();
    if (!file) return;

    let products = [];

    try {
      loading(true, "Đang đọc file Excel...");
      products = await readProductsFromExcel(file);
    } catch (err) {
      toast(err?.message || String(err));
      console.error(err);
      return;
    } finally {
      loading(false);
    }

    if (!products.length) {
      toast("File Excel không có sản phẩm hợp lệ.");
      return;
    }

    const okImport = confirm(
      `Tìm thấy ${products.length} sản phẩm trong file Excel.\n\n` +
      `Bạn có muốn nhập vào D1 không?\n\n` +
      `Lưu ý: mã nào đã tồn tại sẽ được bỏ qua.`
    );

    if (!okImport) return;

    let created = 0;
    let duplicated = 0;
    const failed = [];

    loading(true, `Đang nhập 0/${products.length} sản phẩm...`);

    try {
      for (let i = 0; i < products.length; i++) {
        const p = products[i];

        const label = $("loadingOverlay")?.querySelector("span");
        if (label) label.textContent = `Đang nhập ${i + 1}/${products.length}: ${p.sku}`;

        try {
          await api("/api/products", {
            method: "POST",
            body: p,
          });

          created++;
        } catch (err) {
          const msg = err?.message || String(err);

          if (
            msg.includes("đã tồn tại") ||
            msg.includes("DUPLICATE_SKU") ||
            msg.includes("Mã sản phẩm")
          ) {
            duplicated++;
          } else {
            failed.push(`${p.sku}: ${msg}`);
          }
        }
      }
    } finally {
      loading(false);
    }

    await Promise.all([
      loadProducts(false),
      loadStock(false),
      loadDashboard(false),
    ]);

    const summary =
      `Nhập Excel hoàn tất.\n\n` +
      `Thêm mới: ${created}\n` +
      `Bỏ qua do trùng mã: ${duplicated}\n` +
      `Lỗi: ${failed.length}`;

    if (failed.length) {
      alert(summary + "\n\nChi tiết lỗi:\n" + failed.slice(0, 20).join("\n"));
    } else {
      alert(summary);
    }
  }


  /* =========================================================
     EVENTS
  ========================================================= */

  function bindEvents() {
    $("btnLogin")?.addEventListener("click", login);

    $("loginPassword")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") login();
    });

    $("loginUsername")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("loginPassword")?.focus();
    });

    $("btnLogout")?.addEventListener("click", logout);

    $$(".menu-item").forEach((b) => {
      b.addEventListener("click", () => switchView(b.dataset.view));
    });

    $("btnToggleMenu")?.addEventListener("click", () => {
      $("sidebar")?.classList.toggle("open");
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAllModals();
    });

    document.addEventListener("click", async (e) => {
      const close = e.target.closest("[data-close-modal]");
      if (close) closeModal(close.dataset.closeModal);

      const b = e.target.closest("[data-act]");
      if (!b) return;

      const act = b.dataset.act;

      if (act === "edit-product") {
        await openEditProduct(b.dataset.id);
      }

      if (act === "history-product") {
        switchView("historyView");
        setVal("historySearch", b.dataset.sku || "");
        await loadHistory();
      }

      if (act === "remove-import-line") {
        if ($$("#importLinesBody tr").length <= 1) {
          toast("Cần ít nhất 1 dòng");
          return;
        }

        b.closest("tr")?.remove();
        updateImportTotal();
      }

      if (act === "remove-sale-line") {
        if ($$("#saleLinesBody tr").length <= 1) {
          toast("Cần ít nhất 1 dòng");
          return;
        }

        b.closest("tr")?.remove();
        updateSaleTotal(true);
      }

      if (act === "view-import") {
        await viewImport(b.dataset.id);
      }

      if (act === "view-sale") {
        await viewSale(b.dataset.id);
      }
    });

    $("btnQuickAddProduct")?.addEventListener("click", () => {
      switchView("productsView");
      openProductModal();
    });

    $("btnQuickImport")?.addEventListener("click", () => {
      switchView("importsView");
      openImportModal();
    });

    $("btnQuickSale")?.addEventListener("click", () => {
      switchView("salesView");
      openSaleModal();
    });

    $("btnQuickExportReport")?.addEventListener("click", exportReport);

    $("btnOpenProductModal")?.addEventListener("click", () => openProductModal());
    $("btnSaveProduct")?.addEventListener("click", saveProduct);

    $("p_sku")?.addEventListener("input", () => {
      setVal("p_sku", sku(getVal("p_sku")));
      hide("productDuplicateWarning");
    });

    ["productSearch", "categoryFilter", "stockStatusFilter"].forEach((id) => {
      $(id)?.addEventListener("input", debounce(() => {
        state.productPage = 1;
        loadProducts();
      }, 250));

      $(id)?.addEventListener("change", () => {
        state.productPage = 1;
        loadProducts();
      });
    });

    $("btnProductPrev")?.addEventListener("click", () => {
      if (state.productPage > 1) {
        state.productPage -= 1;
        loadProducts();
      }
    });

    $("btnProductNext")?.addEventListener("click", () => {
      const totalPage = Math.max(1, Math.ceil((state.productTotal || 0) / state.productPageSize));

      if (state.productPage < totalPage) {
        state.productPage += 1;
        loadProducts();
      }
    });

    $("btnOpenImportModal")?.addEventListener("click", openImportModal);

    $("btnAddImportLine")?.addEventListener("click", () => {
      $("importLinesBody")?.insertAdjacentHTML("beforeend", importLineHTML());
    });

    $("btnSaveImport")?.addEventListener("click", saveImport);

    $("importLinesBody")?.addEventListener("input", updateImportTotal);

    ["importSearch", "importFromDate", "importToDate"].forEach((id) => {
      $(id)?.addEventListener("input", debounce(loadImports, 250));
      $(id)?.addEventListener("change", loadImports);
    });

    $("btnFilterImports")?.addEventListener("click", loadImports);

    $("btnOpenSaleModal")?.addEventListener("click", openSaleModal);

    $("btnAddSaleLine")?.addEventListener("click", () => {
      $("saleLinesBody")?.insertAdjacentHTML("beforeend", saleLineHTML());
    });

    $("btnSaveSale")?.addEventListener("click", saveSale);

    $("saleLinesBody")?.addEventListener("input", () => updateSaleTotal(true));

    ["s_platform_fee", "s_discount", "s_other_fee"].forEach((id) => {
      $(id)?.addEventListener("input", () => updateSaleTotal(true));
    });

    $("s_net_amount")?.addEventListener("input", () => updateSaleTotal(false));

    $("s_order_code")?.addEventListener("input", () => hide("saleDuplicateWarning"));

    ["saleSearch", "platformFilter", "saleFromDate", "saleToDate"].forEach((id) => {
      $(id)?.addEventListener("input", debounce(loadSales, 250));
      $(id)?.addEventListener("change", loadSales);
    });

    $("btnFilterSales")?.addEventListener("click", loadSales);

    $("btnStockAdjust")?.addEventListener("click", openAdjustModal);
    $("btnSaveStockAdjust")?.addEventListener("click", saveAdjust);
    $("a_sku")?.addEventListener("input", updateAdjustQty);
    $("a_sku")?.addEventListener("blur", updateAdjustQty);

    ["stockSearch", "stockViewFilter"].forEach((id) => {
      $(id)?.addEventListener("input", debounce(loadStock, 250));
      $(id)?.addEventListener("change", loadStock);
    });

    ["reportFromDate", "reportToDate", "reportPlatform"].forEach((id) => {
      $(id)?.addEventListener("change", loadReport);
    });

    $("btnRunReport")?.addEventListener("click", loadReport);

    ["historySearch", "historyTypeFilter", "historyFromDate", "historyToDate"].forEach((id) => {
      $(id)?.addEventListener("input", debounce(loadHistory, 250));
      $(id)?.addEventListener("change", loadHistory);
    });

    $("btnSaveSettings")?.addEventListener("click", saveSettings);

    $("btnExportProductsExcel")?.addEventListener("click", exportProducts);
    $("btnExportStockExcel")?.addEventListener("click", exportStock);
    $("btnExportHistoryExcel")?.addEventListener("click", exportHistory);
    $("btnExportSalesExcel")?.addEventListener("click", exportSales);
    $("btnExportImportsExcel")?.addEventListener("click", exportImports);
    $("btnExportReportExcel")?.addEventListener("click", exportReport);

    $("btnImportProductsExcel")?.addEventListener("click", importProductsExcel);
  }

  function debounce(fn, wait = 250) {
    let timer = null;

    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  /* =========================================================
     INIT
  ========================================================= */

  function initDates() {
    const d = new Date();
    const first = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;

    setVal("reportFromDate", first);
    setVal("reportToDate", today());
  }

  async function init() {
    bindEvents();
    initDates();
    readSession();

    if (!isApiConfigured()) {
      showLogin();
      toast("Bạn cần đổi API_BASE trong app.js thành link Worker thật.");
      return;
    }

    if (state.token) {
      showApp();
    } else {
      showLogin();
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
