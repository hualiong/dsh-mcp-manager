window.__ModuleLoader__.load({
	id: "@hualiong/dsh-mcp-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		"use strict";
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __export = (target, all) => {
		  for (var name in all)
		    __defProp(target, name, { get: all[name], enumerable: true });
		};
		var __copyProps = (to, from, except, desc) => {
		  if (from && typeof from === "object" || typeof from === "function") {
		    for (let key of __getOwnPropNames(from))
		      if (!__hasOwnProp.call(to, key) && key !== except)
		        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
		  }
		  return to;
		};
		var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

		// src/client/index.tsx
		var index_exports = {};
		__export(index_exports, {
		  apply: () => apply,
		  inject: () => inject
		});
		module.exports = index_exports;

		// src/client/McpManagerSection.tsx
		var import_react = require("react");
		var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		// src/shared.ts
		var MCP_OAUTH_CLIENT_PACKAGE = "@dsh-external/dsh-oauth-mcp-client";
		var RPC_CHANNEL = "/mcp-manager";
		var EVENT_CHANNEL = `${RPC_CHANNEL}/events`;

		// src/client/rpc.ts
		function recordOf(value) {
		  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
		}
		function hostErrorOf(value) {
		  const raw = recordOf(value) ?? {};
		  const code = typeof raw["code"] === "string" ? raw["code"] : "unknown-error";
		  return {
		    code,
		    message: typeof raw["message"] === "string" ? raw["message"] : code,
		    details: recordOf(raw["details"])
		  };
		}
		var McpManagerRpcError = class extends Error {
		  code;
		  fields;
		  constructor(error) {
		    super(`${error.code}: ${error.message}`);
		    this.name = "McpManagerRpcError";
		    this.code = error.code;
		    const fields = error.details?.["fields"];
		    this.fields = recordOf(fields);
		  }
		};
		var McpManagerTransportError = class extends Error {
		  /** HTTP status when a response arrived, otherwise undefined. */
		  status;
		  constructor(message, status) {
		    super(message);
		    this.name = "McpManagerTransportError";
		    this.status = status;
		  }
		};
		async function callRpc(endpoint, payload) {
		  const route = `${RPC_CHANNEL}/${endpoint}`;
		  let response;
		  try {
		    response = await fetch(route, {
		      method: "POST",
		      headers: { "content-type": "application/json" },
		      body: JSON.stringify({ payload: payload ?? null }),
		      credentials: "same-origin"
		    });
		  } catch (cause) {
		    throw new McpManagerTransportError(cause instanceof Error ? cause.message : String(cause));
		  }
		  if (!response.ok) {
		    const text = await response.text().catch(() => "");
		    const detail = text.trim();
		    throw new McpManagerTransportError(
		      `${endpoint}: HTTP ${response.status}${detail === "" ? "" : ` ${detail}`}`,
		      response.status
		    );
		  }
		  let reply;
		  try {
		    reply = await response.json();
		  } catch {
		    throw new McpManagerTransportError(`${endpoint}: reply is not JSON`);
		  }
		  const envelope = recordOf(reply);
		  if (envelope === void 0 || typeof envelope["ok"] !== "boolean") {
		    throw new McpManagerTransportError(`${endpoint}: unexpected reply envelope`);
		  }
		  if (envelope["ok"] === true) return envelope["value"];
		  throw new McpManagerRpcError(hostErrorOf(envelope["error"]));
		}

		// src/client/McpManagerSection.tsx
		var import_jsx_runtime = require("react/jsx-runtime");
		var TRANSPORT_LABELS = {
		  stdio: "STDIO",
		  "streamable-http": "Streamable HTTP"
		};
		function isConnecting(server) {
		  if (!server.enabled) return false;
		  return server.fiberPhase === null || server.fiberPhase === "pending" || server.fiberPhase === "loading";
		}
		var TRANSPORT_OPTIONS = [
		  { value: "streamable-http", label: TRANSPORT_LABELS["streamable-http"] },
		  { value: "stdio", label: TRANSPORT_LABELS.stdio }
		];
		var sectionStyle = {
		  maxWidth: 720,
		  color: "var(--dsw-alias-label-primary)",
		  flexDirection: "column",
		  gap: 12,
		  display: "flex"
		};
		var titleStyle = {
		  color: "var(--dsw-alias-label-primary)",
		  margin: 0,
		  fontSize: 16,
		  fontWeight: 500,
		  lineHeight: "24px"
		};
		var introStyle = {
		  color: "var(--dsw-alias-label-tertiary)",
		  margin: 0,
		  fontSize: 14,
		  lineHeight: "22px"
		};
		var pageHeadStyle = {
		  justifyContent: "space-between",
		  alignItems: "center",
		  gap: 16,
		  display: "flex"
		};
		var titleBlockStyle = {
		  flexDirection: "column",
		  gap: 12,
		  display: "flex",
		  minWidth: 0
		};
		var toolbarStyle = {
		  justifyContent: "flex-end",
		  alignItems: "center",
		  gap: 16,
		  display: "flex"
		};
		var refreshButtonStyle = {
		  width: 28,
		  height: 28,
		  padding: 0,
		  color: "var(--dsw-alias-label-caption)"
		};
		var refreshButtonOffStyle = { opacity: 0.5, cursor: "default" };
		var iconWrapStyle = { display: "inline-flex" };
		var addButtonStyle = {
		  borderRadius: "var(--dsw-radius-md)",
		  height: 32,
		  padding: "0 12px",
		  fontSize: 13,
		  lineHeight: "20px"
		};
		var rowsStyle = {
		  flexDirection: "column",
		  gap: 8,
		  margin: "12px 0 0",
		  padding: 0,
		  listStyle: "none",
		  display: "flex"
		};
		var rowCardStyle = {
		  border: ".5px solid var(--dsw-alias-settings-card-stroke)",
		  background: "var(--dsw-alias-settings-card-fill)",
		  borderRadius: "var(--dsw-radius-xl)",
		  flexDirection: "column",
		  gap: 12,
		  padding: "12px 14px",
		  display: "flex"
		};
		var addCardStyle = {
		  borderRadius: "var(--dsw-radius-lg)",
		  background: "var(--dsw-alias-bg-module-platform)",
		  flexDirection: "column",
		  gap: 14,
		  padding: "14px 16px",
		  listStyle: "none",
		  display: "flex"
		};
		var editorStyle = {
		  borderRadius: "var(--dsw-radius-lg)",
		  background: "var(--dsw-alias-bg-module-platform)",
		  flexDirection: "column",
		  gap: 14,
		  padding: "14px 16px",
		  display: "flex"
		};
		var nestedEditorStyle = {
		  borderRadius: "var(--dsw-radius-lg)",
		  background: "0 0",
		  flexDirection: "column",
		  gap: 14,
		  padding: 0,
		  display: "flex"
		};
		var rowHeadStyle = { alignItems: "center", gap: 10, display: "flex" };
		var rowNameStyle = {
		  color: "var(--dsw-alias-label-primary)",
		  fontSize: 14,
		  fontWeight: 500,
		  lineHeight: "22px",
		  overflow: "hidden",
		  textOverflow: "ellipsis",
		  whiteSpace: "nowrap"
		};
		var rowActionsStyle = { alignItems: "center", gap: 4, marginLeft: "auto", display: "inline-flex" };
		var rowToggleStyle = {
		  boxSizing: "border-box",
		  display: "flex",
		  alignItems: "center",
		  gap: 6,
		  minWidth: 0,
		  flex: "auto",
		  padding: 0,
		  border: 0,
		  background: "0 0",
		  color: "inherit",
		  font: "inherit",
		  textAlign: "left",
		  cursor: "pointer"
		};
		var chevronWrapStyle = {
		  display: "inline-flex",
		  flex: "none",
		  marginLeft: "auto",
		  color: "var(--dsw-alias-label-tertiary)"
		};
		var dotSlotStyle = { flex: "none", display: "inline-flex" };
		var statusLineStyle = { display: "inline-flex", alignItems: "center", gap: 6, margin: 0 };
		var statusTextStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: 13, lineHeight: "20px" };
		var failureStyle = { ...statusTextStyle, color: "var(--dsw-alias-state-error-primary)" };
		var errorLineStyle = {
		  color: "var(--dsw-alias-state-error-primary)",
		  margin: 0,
		  fontSize: 12,
		  lineHeight: "18px"
		};
		var emptyBoxStyle = {
		  border: "1px dashed var(--dsw-alias-border-l3)",
		  borderRadius: "var(--dsw-radius-lg)",
		  textAlign: "center",
		  padding: 12,
		  color: "var(--dsw-alias-label-tertiary)",
		  margin: 0,
		  fontSize: 12,
		  lineHeight: "18px"
		};
		var footerStyle = { display: "flex", alignItems: "center", gap: 8, minWidth: 0 };
		var footerPathStyle = { fontSize: 12, lineHeight: "18px", maxWidth: "100%" };
		var fieldStyle = { flexDirection: "column", gap: 6, display: "flex", flex: 1, minWidth: 0 };
		var labelStyle = {
		  color: "var(--dsw-alias-label-secondary)",
		  alignItems: "center",
		  gap: 10,
		  fontSize: 12,
		  fontWeight: 500,
		  lineHeight: "18px",
		  display: "inline-flex"
		};
		var hintStyle = {
		  color: "var(--dsw-alias-state-error-primary)",
		  margin: 0,
		  fontSize: 12,
		  lineHeight: "18px"
		};
		var fieldRowStyle = { display: "flex", alignItems: "center", gap: 10 };
		var timeoutRowStyle = { justifyContent: "space-between", alignItems: "flex-start", display: "flex" };
		var timeoutFieldStyle = { flex: "0 1 50%" };
		var checkboxFieldStyle = { flexDirection: "column", gap: 6, display: "flex", flex: "0 1 50%" };
		var editorHeaderStyle = {
		  justifyContent: "space-between",
		  alignItems: "flex-start",
		  gap: 8,
		  display: "flex"
		};
		var editorTitleStyle = {
		  color: "var(--dsw-alias-label-primary)",
		  fontSize: 14,
		  fontWeight: 500,
		  lineHeight: "22px"
		};
		var formActionsStyle = { justifyContent: "space-between", alignItems: "center", display: "flex" };
		var formActionsEndStyle = {
		  justifyContent: "flex-end",
		  alignItems: "center",
		  gap: 8,
		  marginLeft: "auto",
		  display: "flex"
		};
		var checkboxCellStyle = {
		  boxSizing: "content-box",
		  height: 32,
		  border: ".5px solid transparent",
		  alignItems: "center",
		  display: "flex"
		};
		var textareaStyle = {
		  boxSizing: "border-box",
		  width: "100%",
		  minHeight: 64,
		  padding: "6px 10px",
		  border: ".5px solid var(--dsw-alias-border-l4)",
		  borderRadius: "var(--dsw-radius-md)",
		  background: "var(--dsw-alias-bg-layer-1)",
		  color: "var(--dsw-alias-label-primary)",
		  font: "inherit",
		  fontSize: 14,
		  lineHeight: "22px",
		  resize: "vertical"
		};
		var dangerButtonStyle = { color: "var(--dsw-alias-state-error-primary)" };
		function errorMessage(error, t) {
		  if (error instanceof McpManagerRpcError) {
		    switch (error.code) {
		      case "duplicate-id":
		        return t("errDuplicateId");
		      case "duplicate-server-name":
		        return t("errDuplicateName");
		      case "invalid-config":
		        return t("errInvalidConfig");
		      case "not-found":
		        return t("errNotFound");
		      // Codes this panel has no copy for fall back to the host's own prose.
		      default:
		        return error.message.replace(/^[a-z-]+: /, "");
		    }
		  }
		  if (error instanceof McpManagerTransportError) return `${t("errTransport")}: ${error.message}`;
		  return error instanceof Error ? error.message : String(error);
		}
		function statusOf(server) {
		  if (!server.enabled) return { dot: "idle", tone: "neutral", key: "statusDisabled" };
		  switch (server.fiberPhase) {
		    case "active":
		      return server.toolCount > 0 ? { dot: "done", tone: "success", key: "toolCount", count: String(server.toolCount) } : { dot: "warning", tone: "warning", key: "statusActiveNoTools" };
		    case "failed":
		      return { dot: "error", tone: "danger", key: "statusFailed" };
		    case "loading":
		      return { dot: "ongoing", tone: "warning", key: "statusLoading" };
		    case "pending":
		      return { dot: "ongoing", tone: "warning", key: "statusPending" };
		    case "unloading":
		      return { dot: "ongoing", tone: "warning", key: "statusUnloading" };
		    default:
		      return { dot: "idle", tone: "outline", key: "statusNotLoaded" };
		  }
		}
		function McpManagerSection({ t }) {
		  const [servers, setServers] = (0, import_react.useState)([]);
		  const [patchInfo, setPatchInfo] = (0, import_react.useState)(null);
		  const [loading, setLoading] = (0, import_react.useState)(true);
		  const [error, setError] = (0, import_react.useState)(null);
		  const [adding, setAdding] = (0, import_react.useState)(false);
		  const [expanded, setExpanded] = (0, import_react.useState)({});
		  const [busy, setBusy] = (0, import_react.useState)(null);
		  const [probes, setProbes] = (0, import_react.useState)({});
		  const [removing, setRemoving] = (0, import_react.useState)(null);
		  const [acknowledged, setAcknowledged] = (0, import_react.useState)(false);
		  const anyExpanded = Object.values(expanded).some((open) => open === true);
		  const formOpen = adding || anyExpanded;
		  const actionsDisabled = busy !== null || formOpen;
		  const refresh = (0, import_react.useCallback)(async (options) => {
		    const quiet = options?.quiet === true;
		    if (!quiet) {
		      setLoading(true);
		      setError(null);
		    }
		    try {
		      const { servers: list } = await callRpc("list");
		      setServers(list);
		      const { patch } = await callRpc("patchInfo");
		      setPatchInfo(patch);
		    } catch (err) {
		      if (!quiet) setError(errorMessage(err, t));
		    } finally {
		      if (!quiet) setLoading(false);
		    }
		  }, [t]);
		  const initialised = (0, import_react.useRef)(false);
		  (0, import_react.useEffect)(() => {
		    if (initialised.current) return;
		    initialised.current = true;
		    void refresh();
		  }, [refresh]);
		  (0, import_react.useEffect)(() => {
		    if (typeof EventSource === "undefined") return;
		    const source = new EventSource(EVENT_CHANNEL);
		    source.onmessage = () => {
		      void refresh({ quiet: true });
		    };
		    source.onerror = () => {
		    };
		    return () => {
		      source.close();
		    };
		  }, [refresh]);
		  (0, import_react.useEffect)(() => {
		    const revalidate = () => {
		      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
		      void refresh({ quiet: true });
		    };
		    const onVisibility = () => {
		      revalidate();
		    };
		    window.addEventListener("focus", revalidate);
		    document.addEventListener("visibilitychange", onVisibility);
		    return () => {
		      window.removeEventListener("focus", revalidate);
		      document.removeEventListener("visibilitychange", onVisibility);
		    };
		  }, [refresh]);
		  const run = (0, import_react.useCallback)(async (action, label) => {
		    setBusy(label);
		    setError(null);
		    try {
		      await action();
		      await refresh({ quiet: true });
		    } catch (err) {
		      setError(errorMessage(err, t));
		    } finally {
		      setBusy(null);
		    }
		  }, [refresh, t]);
		  const displayName = (0, import_react.useCallback)(
		    (server) => server.serverName || t("unnamed"),
		    [t]
		  );
		  const testConnection = (0, import_react.useCallback)((server) => {
		    void run(async () => {
		      const result = await callRpc("probe", { id: server.id });
		      setProbes((prev) => ({ ...prev, [server.id]: result }));
		    }, `probe:${server.id}`);
		  }, [run]);
		  const beginAdd = (0, import_react.useCallback)(() => setAdding(true), []);
		  const closeAdd = (0, import_react.useCallback)(() => setAdding(false), []);
		  const closeCard = (0, import_react.useCallback)((id) => {
		    setExpanded((prev) => ({ ...prev, [id]: false }));
		  }, []);
		  const toggleCard = (0, import_react.useCallback)((id) => {
		    setExpanded((prev) => ({ ...prev, [id]: prev[id] !== true }));
		  }, []);
		  const requestRemove = (0, import_react.useCallback)((server) => {
		    setAcknowledged(false);
		    setRemoving(server);
		  }, []);
		  const confirmRemove = (0, import_react.useCallback)(() => {
		    const target = removing;
		    if (target === null) return;
		    setRemoving(null);
		    void run(() => callRpc("remove", { id: target.id }), `remove:${target.id}`);
		  }, [removing, run]);
		  const savedAdd = (0, import_react.useCallback)(() => {
		    setAdding(false);
		    void run(() => Promise.resolve(), "form:add");
		  }, [run]);
		  const savedEdit = (0, import_react.useCallback)((id) => {
		    closeCard(id);
		    void run(() => Promise.resolve(), `form:update:${id}`);
		  }, [closeCard, run]);
		  const toggleEnabled = (0, import_react.useCallback)((server) => {
		    void run(
		      () => callRpc("setEnabled", { id: server.id, enabled: !server.enabled }),
		      `toggle:${server.id}`
		    );
		  }, [run]);
		  const summary = (0, import_react.useMemo)(() => {
		    const enabled = servers.filter((s) => s.enabled).length;
		    const connected = servers.filter((s) => s.enabled && s.fiberPhase === "active" && s.toolCount > 0).length;
		    const failed = servers.filter((s) => s.enabled && s.fiberPhase === "failed").length;
		    return { total: servers.length, enabled, connected, failed };
		  }, [servers]);
		  const summaryText = (0, import_react.useMemo)(() => {
		    const parts = [
		      t("total", { count: String(summary.total) }),
		      t("connected", { count: String(summary.connected) })
		    ];
		    if (summary.failed > 0) parts.push(t("failed", { count: String(summary.failed) }));
		    parts.push(t("enabledOf", { count: String(summary.enabled), total: String(summary.total) }));
		    return parts.join(" \xB7 ");
		  }, [summary, t]);
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { style: sectionStyle, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", { style: pageHeadStyle, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: titleBlockStyle, children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { style: titleStyle, children: t("title") }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: introStyle, children: summaryText })
		      ] }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: toolbarStyle, children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		          import_dsh_client_ui_primitives.Tooltip,
		          {
		            label: t("refresh"),
		            delayMs: 500,
		            focusDelayMs: 500,
		            side: "bottom",
		            portal: true,
		            disabled: loading || busy !== null,
		            children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		              import_dsh_client_ui_primitives.Button,
		              {
		                variant: "ghost",
		                size: "sm",
		                style: loading || busy !== null ? { ...refreshButtonStyle, ...refreshButtonOffStyle } : refreshButtonStyle,
		                "aria-label": t("refresh"),
		                "aria-busy": loading,
		                disabled: loading || busy !== null,
		                onClick: () => void refresh(),
		                children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: iconWrapStyle, "aria-hidden": "true", children: loading ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: "ongoing", size: 18 }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconRefreshOutlineRegular, {}) })
		              }
		            )
		          }
		        ),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		          import_dsh_client_ui_primitives.Button,
		          {
		            variant: "primary",
		            size: "sm",
		            style: addButtonStyle,
		            icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconPlusOutlineRegular, { size: 13 }),
		            onClick: beginAdd,
		            disabled: busy !== null || formOpen,
		            children: t("addMcp")
		          }
		        )
		      ] })
		    ] }),
		    error !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: errorLineStyle, role: "alert", children: error }) : null,
		    loading && servers.length === 0 && !formOpen ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: statusLineStyle, role: "status", children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: dotSlotStyle, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: "ongoing", size: 10 }) }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: statusTextStyle, children: t("loading") })
		    ] }) : null,
		    !loading && servers.length === 0 && !formOpen ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: emptyBoxStyle, children: [
		      t("empty"),
		      " ",
		      t("emptyHint")
		    ] }) : null,
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("ul", { style: rowsStyle, children: [
		      adding ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { style: addCardStyle, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: nestedEditorStyle, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        ServerForm,
		        {
		          t,
		          initial: void 0,
		          busy: busy !== null,
		          onCancel: closeAdd,
		          onSaved: savedAdd
		        }
		      ) }) }, "add") : null,
		      servers.map((server) => {
		        const status = statusOf(server);
		        const statusText = t(status.key, status.count !== void 0 ? { count: status.count } : void 0);
		        const open = expanded[server.id] === true;
		        const probe = probes[server.id];
		        const probing = busy === `probe:${server.id}`;
		        const failed = server.enabled && server.fiberPhase === "failed";
		        const oauth = server.ownerPackage === MCP_OAUTH_CLIENT_PACKAGE;
		        const regionId = `mcp-details-${server.id}`;
		        return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
		          "li",
		          {
		            style: rowCardStyle,
		            "data-open": open ? "true" : void 0,
		            "data-failed": failed ? "true" : void 0,
		            children: [
		              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: rowHeadStyle, children: [
		                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
		                  "button",
		                  {
		                    type: "button",
		                    style: rowToggleStyle,
		                    "aria-expanded": open,
		                    "aria-controls": open ? regionId : void 0,
		                    onClick: () => toggleCard(server.id),
		                    children: [
		                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: rowNameStyle, children: displayName(server) }),
		                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: status.tone, children: statusText }),
		                      isConnecting(server) ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "neutral", children: t("connecting") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "neutral", children: TRANSPORT_LABELS[server.transport] }),
		                      oauth ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "info", children: "OAuth" }) : null,
		                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...chevronWrapStyle, transform: open ? "rotate(180deg)" : "none" }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { size: 12 }) })
		                    ]
		                  }
		                ),
		                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: rowActionsStyle, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		                  import_dsh_client_ui_primitives.Switch,
		                  {
		                    checked: server.enabled,
		                    label: t("enable"),
		                    title: server.enabled ? t("disable") : t("enable"),
		                    disabled: actionsDisabled,
		                    onChange: () => toggleEnabled(server)
		                  }
		                ) })
		              ] }),
		              open ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: editorStyle, id: regionId, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		                ServerForm,
		                {
		                  t,
		                  initial: server,
		                  oauth,
		                  busy: busy !== null,
		                  probe,
		                  probing,
		                  onTest: () => testConnection(server),
		                  onRemove: () => requestRemove(server),
		                  onCancel: () => closeCard(server.id),
		                  onSaved: () => savedEdit(server.id)
		                }
		              ) }) : null
		            ]
		          },
		          server.id
		        );
		      })
		    ] }),
		    patchInfo !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: footerStyle, children: [
		      patchInfo.exists ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "warning", children: t("patchMissing") }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.PathLabel, { path: patchInfo.path, style: footerPathStyle })
		    ] }) : null,
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		      import_dsh_client_ui_primitives.RiskConfirmation,
		      {
		        open: removing !== null,
		        title: t("removeTitle"),
		        description: t("removeDesc", {
		          name: removing !== null ? displayName(removing) : "",
		          id: removing?.id ?? ""
		        }),
		        acknowledgeLabel: t("removeAck"),
		        cancelLabel: t("cancel"),
		        closeLabel: t("cancel"),
		        confirmLabel: t("remove"),
		        acknowledged,
		        disabled: busy !== null,
		        onAcknowledgedChange: setAcknowledged,
		        onCancel: () => setRemoving(null),
		        onConfirm: confirmRemove
		      }
		    )
		  ] });
		}
		var EMPTY_FORM = {
		  id: "",
		  serverName: "",
		  transport: "streamable-http",
		  url: "",
		  command: "",
		  argsText: "",
		  envText: "",
		  cwd: "",
		  headersText: "",
		  toolCallTimeoutMs: "",
		  failOnStartupError: false,
		  credentialRef: "",
		  callbackPort: ""
		};
		function toForm(server) {
		  if (server === void 0) return EMPTY_FORM;
		  return {
		    id: server.id,
		    serverName: server.serverName,
		    transport: server.transport,
		    url: server.url ?? "",
		    command: server.command ?? "",
		    argsText: (server.args ?? []).join("\n"),
		    envText: (server.env !== void 0 ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`) : []).join("\n"),
		    cwd: server.cwd ?? "",
		    headersText: (server.headers !== void 0 ? Object.entries(server.headers).map(([k, v]) => `${k}: ${v}`) : []).join("\n"),
		    toolCallTimeoutMs: server.toolCallTimeoutMs !== void 0 ? String(server.toolCallTimeoutMs) : "",
		    failOnStartupError: server.failOnStartupError === true,
		    credentialRef: server.credentialRef ?? "",
		    callbackPort: server.callbackPort !== void 0 ? String(server.callbackPort) : ""
		  };
		}
		function splitLines(text) {
		  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
		}
		function stripQuotes(value) {
		  const trimmed = value.trim();
		  if (trimmed.length >= 2) {
		    const first = trimmed[0];
		    const last = trimmed[trimmed.length - 1];
		    if (first === '"' && last === '"' || first === "'" && last === "'") {
		      return trimmed.slice(1, -1).trim();
		    }
		  }
		  return trimmed;
		}
		function parsePairs(text) {
		  const lines = splitLines(text);
		  if (lines.length === 0) return void 0;
		  const out = {};
		  for (const line of lines) {
		    const eq = line.indexOf("=");
		    const colon = line.indexOf(":");
		    const sep = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon);
		    if (sep <= 0) continue;
		    out[stripQuotes(line.slice(0, sep))] = stripQuotes(line.slice(sep + 1));
		  }
		  return out;
		}
		function toConfig(form, oauth) {
		  const config = {
		    serverName: form.serverName.trim(),
		    transport: form.transport
		  };
		  if (form.transport === "streamable-http") {
		    if (form.url.trim() !== "") config.url = form.url.trim();
		  } else {
		    if (form.command.trim() !== "") config.command = form.command.trim();
		    const args = splitLines(form.argsText);
		    if (args.length > 0) config.args = args;
		    const env = parsePairs(form.envText);
		    if (env !== void 0) config.env = env;
		    if (form.cwd.trim() !== "") config.cwd = form.cwd.trim();
		  }
		  const headers = parsePairs(form.headersText);
		  if (headers !== void 0) config.headers = headers;
		  if (form.toolCallTimeoutMs.trim() !== "" && Number.isFinite(Number(form.toolCallTimeoutMs))) {
		    config.toolCallTimeoutMs = Number(form.toolCallTimeoutMs);
		  }
		  if (form.failOnStartupError) config.failOnStartupError = true;
		  if (oauth) {
		    if (form.credentialRef.trim() !== "") config.credentialRef = form.credentialRef.trim();
		    if (form.callbackPort.trim() !== "" && Number.isFinite(Number(form.callbackPort))) {
		      config.callbackPort = Number(form.callbackPort);
		    }
		  }
		  return config;
		}
		function Field({ labelFor, label, hint, style, onLabelClick, children }) {
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...fieldStyle, ...style }, children: [
		    labelFor === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		      "span",
		      {
		        style: onLabelClick === void 0 ? labelStyle : { ...labelStyle, cursor: "pointer" },
		        onClick: onLabelClick,
		        children: label
		      }
		    ) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { style: labelStyle, htmlFor: labelFor, children: label }),
		    children,
		    hint !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: hintStyle, children: hint }) : null
		  ] });
		}
		function ServerForm({
		  t,
		  initial,
		  oauth,
		  busy,
		  probe,
		  probing,
		  onTest,
		  onRemove,
		  onCancel,
		  onSaved
		}) {
		  const editing = initial !== void 0;
		  const [form, setForm] = (0, import_react.useState)(() => toForm(initial));
		  const [fieldErrors, setFieldErrors] = (0, import_react.useState)({});
		  const [submitError, setSubmitError] = (0, import_react.useState)(null);
		  const [saving, setSaving] = (0, import_react.useState)(false);
		  const set = (key, value) => {
		    setForm((prev) => ({ ...prev, [key]: value }));
		  };
		  const submit = async () => {
		    setSaving(true);
		    setSubmitError(null);
		    setFieldErrors({});
		    try {
		      const payload = { id: form.id.trim(), config: toConfig(form, oauth === true) };
		      await callRpc(editing ? "update" : "add", payload);
		      onSaved();
		    } catch (err2) {
		      setFieldErrors(err2 instanceof McpManagerRpcError ? err2.fields ?? {} : {});
		      setSubmitError(errorMessage(err2, t));
		    } finally {
		      setSaving(false);
		    }
		  };
		  const err = (key) => fieldErrors[key];
		  const locked = saving || busy;
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: editorHeaderStyle, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: editorTitleStyle, children: editing ? t("formEditTitle", { name: initial.serverName }) : t("formAddTitle") }),
		      onRemove !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        import_dsh_client_ui_primitives.Button,
		        {
		          variant: "ghost",
		          size: "sm",
		          style: dangerButtonStyle,
		          icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconTrashOutlineRegular, { size: 14 }),
		          onClick: onRemove,
		          disabled: locked,
		          children: t("remove")
		        }
		      ) : null
		    ] }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: fieldRowStyle, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { labelFor: "dshmcp-id", label: t("fieldId"), hint: err("id"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        import_dsh_client_ui_primitives.Input,
		        {
		          id: "dshmcp-id",
		          value: form.id,
		          placeholder: "mcp-github",
		          spellCheck: false,
		          "aria-invalid": err("id") !== void 0,
		          disabled: editing || locked,
		          onChange: (e) => set("id", e.target.value)
		        }
		      ) }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { labelFor: "dshmcp-server", label: t("fieldServerName"), hint: err("serverName"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        import_dsh_client_ui_primitives.Input,
		        {
		          id: "dshmcp-server",
		          value: form.serverName,
		          placeholder: "github",
		          spellCheck: false,
		          "aria-invalid": err("serverName") !== void 0,
		          disabled: locked,
		          onChange: (e) => set("serverName", e.target.value)
		        }
		      ) })
		    ] }),
		    oauth === true ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("fieldTransport"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		      import_dsh_client_ui_primitives.SegmentedControl,
		      {
		        id: "dshmcp-transport",
		        value: form.transport,
		        options: TRANSPORT_OPTIONS,
		        label: t("fieldTransport"),
		        disabled: locked,
		        onChange: (next) => set("transport", next)
		      }
		    ) }),
		    form.transport === "streamable-http" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { labelFor: "dshmcp-url", label: t("fieldUrl"), hint: err("url"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		      import_dsh_client_ui_primitives.Input,
		      {
		        id: "dshmcp-url",
		        value: form.url,
		        placeholder: "http://127.0.0.1:3000/mcp",
		        spellCheck: false,
		        "aria-invalid": err("url") !== void 0,
		        disabled: locked,
		        onChange: (e) => set("url", e.target.value)
		      }
		    ) }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { labelFor: "dshmcp-command", label: t("fieldCommand"), hint: err("command"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        import_dsh_client_ui_primitives.Input,
		        {
		          id: "dshmcp-command",
		          value: form.command,
		          placeholder: "npx",
		          spellCheck: false,
		          "aria-invalid": err("command") !== void 0,
		          disabled: locked,
		          onChange: (e) => set("command", e.target.value)
		        }
		      ) }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { labelFor: "dshmcp-args", label: t("fieldArgs"), hint: err("args"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        "textarea",
		        {
		          id: "dshmcp-args",
		          style: textareaStyle,
		          rows: 3,
		          value: form.argsText,
		          placeholder: "-y\n@modelcontextprotocol/server-github",
		          spellCheck: false,
		          disabled: locked,
		          onChange: (e) => set("argsText", e.target.value)
		        }
		      ) }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { labelFor: "dshmcp-env", label: t("fieldEnv"), hint: err("env"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        "textarea",
		        {
		          id: "dshmcp-env",
		          style: textareaStyle,
		          rows: 3,
		          value: form.envText,
		          placeholder: "GITHUB_TOKEN=ghp_xxx",
		          spellCheck: false,
		          disabled: locked,
		          onChange: (e) => set("envText", e.target.value)
		        }
		      ) }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { labelFor: "dshmcp-cwd", label: t("fieldCwd"), hint: err("cwd"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        import_dsh_client_ui_primitives.Input,
		        {
		          id: "dshmcp-cwd",
		          value: form.cwd,
		          spellCheck: false,
		          "aria-invalid": err("cwd") !== void 0,
		          disabled: locked,
		          onChange: (e) => set("cwd", e.target.value)
		        }
		      ) })
		    ] }),
		    oauth === true ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: fieldRowStyle, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { labelFor: "dshmcp-credential", label: t("fieldCredentialRef"), hint: err("credentialRef"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        import_dsh_client_ui_primitives.Input,
		        {
		          id: "dshmcp-credential",
		          value: form.credentialRef,
		          placeholder: "CLOUDFLARE_MCP_OAUTH",
		          spellCheck: false,
		          "aria-invalid": err("credentialRef") !== void 0,
		          disabled: locked,
		          onChange: (e) => set("credentialRef", e.target.value)
		        }
		      ) }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { labelFor: "dshmcp-callback-port", label: t("fieldCallbackPort"), hint: err("callbackPort"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        import_dsh_client_ui_primitives.Input,
		        {
		          id: "dshmcp-callback-port",
		          value: form.callbackPort,
		          inputMode: "numeric",
		          placeholder: "45871",
		          "aria-invalid": err("callbackPort") !== void 0,
		          disabled: locked,
		          onChange: (e) => set("callbackPort", e.target.value.replace(/[^0-9]/g, ""))
		        }
		      ) })
		    ] }) : null,
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { labelFor: "dshmcp-headers", label: t("fieldHeaders"), hint: err("headers"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		      "textarea",
		      {
		        id: "dshmcp-headers",
		        style: textareaStyle,
		        rows: 2,
		        value: form.headersText,
		        placeholder: "Authorization: Bearer xxx",
		        spellCheck: false,
		        disabled: locked,
		        onChange: (e) => set("headersText", e.target.value)
		      }
		    ) }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: timeoutRowStyle, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        Field,
		        {
		          labelFor: "dshmcp-timeout",
		          label: t("fieldTimeout"),
		          hint: err("toolCallTimeoutMs"),
		          style: timeoutFieldStyle,
		          children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		            import_dsh_client_ui_primitives.Input,
		            {
		              id: "dshmcp-timeout",
		              value: form.toolCallTimeoutMs,
		              inputMode: "numeric",
		              placeholder: "60000",
		              "aria-invalid": err("toolCallTimeoutMs") !== void 0,
		              disabled: locked,
		              onChange: (e) => set("toolCallTimeoutMs", e.target.value.replace(/[^0-9]/g, ""))
		            }
		          )
		        }
		      ),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        Field,
		        {
		          label: t("fieldFailStartup"),
		          style: checkboxFieldStyle,
		          onLabelClick: () => set("failOnStartupError", !form.failOnStartupError),
		          children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: checkboxCellStyle, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		            import_dsh_client_ui_primitives.Checkbox,
		            {
		              checked: form.failOnStartupError,
		              label: "",
		              title: t("fieldFailStartup"),
		              disabled: locked,
		              onChange: (next) => set("failOnStartupError", next)
		            }
		          ) })
		        }
		      )
		    ] }),
		    submitError !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: errorLineStyle, role: "alert", children: submitError }) : null,
		    probe !== void 0 ? probe.skipped === true ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: statusLineStyle, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: dotSlotStyle, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: "warning", size: 10 }) }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: statusTextStyle, children: [
		        t("probeSkipped"),
		        " ",
		        probe.error ?? ""
		      ] })
		    ] }) : probe.ok ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: statusLineStyle, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: dotSlotStyle, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: "done", size: 10 }) }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: statusTextStyle, children: t("probeOk", {
		        ms: String(probe.latencyMs),
		        count: probe.toolCount !== void 0 ? String(probe.toolCount) : "?"
		      }) })
		    ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: statusLineStyle, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: dotSlotStyle, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: "error", size: 10 }) }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: failureStyle, children: t("probeFail", { error: probe.error ?? "failed", ms: String(probe.latencyMs) }) })
		    ] }) : null,
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: formActionsStyle, children: [
		      editing && onTest !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        import_dsh_client_ui_primitives.Button,
		        {
		          variant: "outline",
		          size: "sm",
		          icon: probing === true ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: "ongoing", size: 14 }) : void 0,
		          onClick: onTest,
		          disabled: locked,
		          children: t("test")
		        }
		      ) : null,
		      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: formActionsEndStyle, children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", onClick: onCancel, disabled: saving, children: t("cancel") }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		          import_dsh_client_ui_primitives.Button,
		          {
		            variant: "primary",
		            size: "sm",
		            icon: saving ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: "ongoing", size: 14 }) : void 0,
		            onClick: () => void submit(),
		            disabled: locked,
		            children: editing ? t("save") : t("addMcp")
		          }
		        )
		      ] })
		    ] })
		  ] });
		}

		// src/client/locales.ts
		var NS = "mcpManager";
		var zh = {
		  nav: "MCP",
		  title: "MCP \u670D\u52A1\u5668",
		  unnamed: "\uFF08\u672A\u547D\u540D\uFF09",
		  total: "\u5171 {count} \u4E2A",
		  addMcp: "\u6DFB\u52A0 MCP",
		  connected: "{count} \u4E2A\u5DF2\u8FDE\u63A5",
		  failed: "{count} \u4E2A\u5931\u8D25",
		  enabledOf: "{count}/{total} \u5DF2\u542F\u7528",
		  refresh: "\u5237\u65B0",
		  loading: "\u6B63\u5728\u52A0\u8F7D\u670D\u52A1\u5668\u2026",
		  empty: "\u5C1A\u672A\u914D\u7F6E MCP \u670D\u52A1\u5668\u3002",
		  emptyHint: "\u70B9\u51FB\u201C\u6DFB\u52A0 MCP\u201D\u5F00\u59CB\u63A5\u5165\u3002",
		  patchMissing: "\u8865\u4E01\u6587\u4EF6\u7F3A\u5931",
		  removeTitle: "\u5220\u9664 MCP \u670D\u52A1\u5668",
		  removeDesc: "\u5C06\u4ECE cordis.patch.yml \u4E2D\u5220\u9664\u201C{name}\u201D\uFF08{id}\uFF09\uFF0C\u5E76\u65AD\u5F00\u5B83\u7684\u5168\u90E8\u5DE5\u5177\u3002\u6B64\u64CD\u4F5C\u4E0D\u53EF\u6062\u590D\u3002",
		  removeAck: "\u6211\u4E86\u89E3\u8FD9\u4F1A\u4FEE\u6539 cordis.patch.yml \u5E76\u65AD\u5F00\u8BE5\u670D\u52A1\u5668\u7684\u5DE5\u5177",
		  statusActiveNoTools: "\u65E0\u5DE5\u5177",
		  statusFailed: "\u5931\u8D25",
		  statusDisabled: "\u5DF2\u505C\u7528",
		  statusLoading: "\u52A0\u8F7D\u4E2D",
		  statusPending: "\u7B49\u5F85\u4E2D",
		  statusUnloading: "\u5378\u8F7D\u4E2D",
		  statusNotLoaded: "\u672A\u52A0\u8F7D",
		  connecting: "\u8FDE\u63A5\u4E2D",
		  toolCount: "{count} \u4E2A\u5DE5\u5177",
		  probeOk: "\u5DF2\u8FDE\u63A5\uFF0C\u8017\u65F6 {ms}ms \xB7 {count} \u4E2A\u5DE5\u5177",
		  probeFail: "{error}\uFF08{ms}ms\uFF09",
		  probeSkipped: "\u672A\u68C0\u6D4B",
		  enable: "\u542F\u7528",
		  disable: "\u505C\u7528",
		  test: "\u6D4B\u8BD5",
		  remove: "\u5220\u9664",
		  formAddTitle: "\u6DFB\u52A0 MCP \u670D\u52A1\u5668",
		  formEditTitle: "\u7F16\u8F91 {name}",
		  fieldId: "\u6761\u76EE ID",
		  fieldServerName: "serverName",
		  fieldTransport: "\u4F20\u8F93\u65B9\u5F0F",
		  fieldUrl: "URL",
		  fieldCommand: "\u547D\u4EE4",
		  fieldArgs: "\u53C2\u6570\uFF08\u6BCF\u884C\u4E00\u4E2A\uFF09",
		  fieldEnv: "\u73AF\u5883\u53D8\u91CF\uFF08KEY=VALUE\uFF0C\u6BCF\u884C\u4E00\u4E2A\uFF09",
		  fieldCwd: "\u5DE5\u4F5C\u76EE\u5F55\uFF08\u53EF\u9009\uFF09",
		  fieldHeaders: "\u8BF7\u6C42\u5934\uFF08Key: Value\uFF0C\u6BCF\u884C\u4E00\u4E2A\uFF09",
		  fieldTimeout: "\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF0C\u53EF\u9009\uFF09",
		  fieldFailStartup: "\u542F\u52A8\u5931\u8D25\u5373\u62A5\u9519",
		  fieldCredentialRef: "\u51ED\u636E\u5F15\u7528\uFF08OAuth\uFF09",
		  fieldCallbackPort: "\u56DE\u8C03\u7AEF\u53E3\uFF08OAuth\uFF09",
		  cancel: "\u53D6\u6D88",
		  save: "\u4FDD\u5B58",
		  errDuplicateId: "\u6761\u76EE ID \u5DF2\u88AB\u4F7F\u7528",
		  errDuplicateName: "serverName \u5DF2\u88AB\u5176\u4ED6\u670D\u52A1\u5668\u4F7F\u7528",
		  errInvalidConfig: "MCP \u670D\u52A1\u5668\u914D\u7F6E\u65E0\u6548",
		  errNotFound: "\u672A\u627E\u5230\u8BE5 MCP \u670D\u52A1\u5668\u6761\u76EE",
		  errTransport: "\u65E0\u6CD5\u8BBF\u95EE\u4E3B\u8FDB\u7A0B"
		};
		var en = {
		  nav: "MCP",
		  title: "MCP servers",
		  unnamed: "(unnamed)",
		  total: "{count} total",
		  addMcp: "Add MCP",
		  connected: "{count} connected",
		  failed: "{count} failed",
		  enabledOf: "{count}/{total} enabled",
		  refresh: "Refresh",
		  loading: "Loading servers\u2026",
		  empty: "No MCP servers configured.",
		  emptyHint: "Use \u201CAdd MCP\u201D to connect one.",
		  patchMissing: "patch file missing",
		  removeTitle: "Remove MCP server",
		  removeDesc: 'This removes "{name}" ({id}) from cordis.patch.yml and disconnects all of its tools. It cannot be undone.',
		  removeAck: "I understand this edits cordis.patch.yml and disconnects this server\u2019s tools",
		  statusActiveNoTools: "No tools",
		  statusFailed: "Failed",
		  statusDisabled: "Disabled",
		  statusLoading: "Loading",
		  statusPending: "Pending",
		  statusUnloading: "Unloading",
		  statusNotLoaded: "Not loaded",
		  connecting: "Connecting",
		  toolCount: "{count} tools",
		  probeOk: "Connected in {ms}ms \xB7 {count} tools",
		  probeFail: "{error} ({ms}ms)",
		  probeSkipped: "Not probed",
		  enable: "Enable",
		  disable: "Disable",
		  test: "Test",
		  remove: "Remove",
		  formAddTitle: "Add MCP server",
		  formEditTitle: "Edit {name}",
		  fieldId: "Entry id",
		  fieldServerName: "serverName",
		  fieldTransport: "Transport",
		  fieldUrl: "URL",
		  fieldCommand: "Command",
		  fieldArgs: "Args (one per line)",
		  fieldEnv: "Env (KEY=VALUE, one per line)",
		  fieldCwd: "Working directory (optional)",
		  fieldHeaders: "Headers (Key: Value, one per line)",
		  fieldTimeout: "Timeout (ms, optional)",
		  fieldFailStartup: "Fail on startup error",
		  fieldCredentialRef: "Credential reference (OAuth)",
		  fieldCallbackPort: "Callback port (OAuth)",
		  cancel: "Cancel",
		  save: "Save",
		  errDuplicateId: "Entry id is already in use",
		  errDuplicateName: "serverName is already used by another server",
		  errInvalidConfig: "Invalid MCP server configuration",
		  errNotFound: "MCP server entry not found",
		  errTransport: "Cannot reach the host"
		};

		// src/client/index.tsx
		var inject = ["slots", "locale"];
		var SECTION_ORDER = 18;
		function apply(ctx) {
		  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "mcp-manager: locale");
		  const t = ctx.locale.bind(NS);
		  ctx.slots.inject("settings.section", () => ctx.slots.register({
		    name: "settings.section",
		    id: "mcp",
		    order: SECTION_ORDER,
		    label: () => t("nav"),
		    locale: NS
		  }, McpManagerSection));
		}
		//# sourceMappingURL=client.js.map


		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
