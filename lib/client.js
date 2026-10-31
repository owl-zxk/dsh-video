/**
 * dsh-video —— 客户端半边：DSH「设置」里的 **视频理解** section。
 *
 * 为什么是手写的、没有构建链（与 dsh-bili-whale 同一种做法）：
 *   宿主只加载 lib/client.js 这个**已经能跑**的文件（package.json 的
 *   exports['./client'] + dsh.client.platform='web'），它不跑我们的构建脚本。
 *   所以这里不能有 JSX / TypeScript / import 语句 —— 只有 require('react') 和 h()。
 *   代价是这个文件长得不像源码，好处是装上去就能用，没有 build 步骤会坏。
 *
 * 数据流：section ⇄ 同源 fetch /dsh-video/api/config ⇄ $DSH_HOME/dsh-video.config.json
 *   → 宿主侧每次 execute 都会重新读那个文件，所以**保存即生效，不用重启**。
 *
 * 为什么只放 4 个可编辑项：不是能配什么就摆什么，而是改了有意义的那几项。
 *   路径类字段也放上来了，但收进折叠区 —— 它们平时不该被手滑改掉。
 */
window.__ModuleLoader__.load({
  id: "dsh-video-zxk",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useCallback, useEffect, useState } = React;

    const API = "/dsh-video/api";
    const CSS_TAG = "dsh-video/section.css";
    const CSS = [
      ".dvw{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}",
      ".dvw-title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
      ".dvw-intro{color:var(--dsw-alias-label-tertiary);margin:0 0 4px;font-size:13px;line-height:20px}",
      ".dvw-group{margin-top:14px;font-size:13px;font-weight:600;line-height:20px}",
      ".dvw-rows{display:flex;flex-direction:column}",
      ".dvw-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}",
      ".dvw-row:last-child{border-bottom:none}",
      ".dvw-row>div:first-child{flex:1;min-width:190px}",
      ".dvw-label{font-size:13px;line-height:19px}",
      ".dvw-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px}",
      ".dvw-input,.dvw-select{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:190px;outline:none}",
      ".dvw-input:focus-visible,.dvw-select:focus-visible{border-color:var(--dsw-alias-brand-primary)}",
      ".dvw-input.dvw-wide{min-width:300px}",
      ".dvw-stack{display:flex;flex-direction:column;gap:6px;align-items:flex-start}",
      ".dvw-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}",
      ".dvw-btn{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:6px;font-size:12.5px;height:30px;padding:0 12px;cursor:pointer}",
      ".dvw-btn:disabled{opacity:.5;cursor:default}",
      ".dvw-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
      ".dvw-err{margin-top:10px;font-size:12.5px;line-height:18px;color:#ff5a5f;white-space:pre-wrap}",
      ".dvw-out{margin-top:10px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}",
      ".dvw-dirty{color:#ffb020;font-size:12.5px;margin-left:4px}",
      ".dvw-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;word-break:break-all}",
      ".dvw-summary{cursor:pointer;margin-top:8px;font-size:12.5px;color:var(--dsw-alias-label-tertiary)}",
    ].join("");

    function useStyleOnce() {
      useEffect(() => {
        if (typeof document === "undefined") return;
        if (!document.getElementById(CSS_TAG)) {
          const el = document.createElement("style");
          el.id = CSS_TAG;
          el.textContent = CSS;
          document.head.appendChild(el);
        }
      }, []);
    }

    function Row(props) {
      return h("div", { className: "dvw-row" },
        h("div", null,
          h("div", { className: "dvw-label" }, props.label),
          props.hint ? h("div", { className: "dvw-hint" }, props.hint) : null),
        h("div", { className: "dvw-stack" }, props.children));
    }

    function asText(value) {
      return value === null || value === undefined ? "" : String(value);
    }

    // ── 墙钟的单位换算 ──────────────────────────────────────────────────────
    // 界面用**分钟**（300000 这种毫秒数人读不出来），存储仍然用毫秒 —— 工具参数
    // 叫 maxWallClockMs、后端校验也按毫秒，改存储单位会牵动 API 与契约，不值当。
    // 所以 draft 里放分钟、save() 时乘回去；三个函数都只在界面上用，不进后端。

    /** 毫秒 → 输入框里的分钟；空/坏值一律给空串（输入框留空 = 用默认）。 */
    function msToMin(value) {
      const n = Number(value);
      if (value === null || value === undefined || value === "" || !Number.isFinite(n) || n <= 0) return "";
      return String(n / 60000);
    }

    /** 分钟 → 毫秒；空串保持空串（= 清除这一项）。非法输入原样回传，让后端 400 说清楚，不在这里悄悄变 NaN。 */
    function minToMs(value) {
      if (value === null || value === undefined || String(value).trim() === "") return "";
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? String(Math.round(n * 60000)) : String(value);
    }

    /** 只读回显：毫秒折成「5 分钟」这种人话。 */
    function minLabel(value) {
      const n = Number(value);
      if (value === null || value === undefined || value === "" || !Number.isFinite(n) || n <= 0) return "—";
      return Math.round((n / 60000) * 100) / 100 + " 分钟";
    }


    function VideoSection() {
      useStyleOnce();
      const [data, setData] = useState(null);
      const [draft, setDraft] = useState({});
      const [savedJson, setSavedJson] = useState("");
      const [busy, setBusy] = useState("");
      const [err, setErr] = useState("");
      const [out, setOut] = useState("");
      const [customModel, setCustomModel] = useState(false);

      const adopt = useCallback((payload) => {
        const cfg = payload.config ?? {};
        const next = {
          model: asText(cfg.model),
          detail: asText(cfg.detail),
          concurrency: asText(cfg.concurrency),
          // 界面用分钟、存储用毫秒：这里把毫秒折成分钟，save() 再乘回去
          maxWallClockMs: msToMin(cfg.maxWallClockMs),
          lang: asText(cfg.lang),
          ffmpeg: asText(cfg.ffmpeg),
          ffprobe: asText(cfg.ffprobe),
          whisperBin: asText(cfg.whisperBin),
          whisperDir: asText(cfg.whisperDir),
        };
        setDraft(next);
        setSavedJson(JSON.stringify(next));
        const values = (payload.candidates ?? []).map((c) => c.value);
        setCustomModel(next.model !== "" && !values.includes(next.model));
      }, []);

      const load = useCallback(async () => {
        setErr("");
        setOut("");
        try {
          const r = await fetch(API + "/config", { headers: { accept: "application/json" } });
          if (!r.ok) throw new Error("HTTP " + r.status + (r.status === 403 ? "（被信任栅栏拒绝）" : ""));
          const j = await r.json();
          setData(j);
          adopt(j);
          if (j.fileError) setErr("配置文件有问题：" + j.fileError);
        } catch (e) {
          setErr("读取配置失败：" + e.message);
        }
      }, [adopt]);

      useEffect(() => { load(); }, [load]);

      const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

      const dirty = savedJson !== "" && JSON.stringify(draft) !== savedJson;

      const save = async () => {
        setBusy("save");
        setErr("");
        setOut("");
        try {
          const r = await fetch(API + "/config", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ config: { ...draft, maxWallClockMs: minToMs(draft.maxWallClockMs) } }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
          const fresh = await fetch(API + "/config", { headers: { accept: "application/json" } });
          const freshJson = fresh.ok ? await fresh.json() : null;
          if (freshJson) { setData(freshJson); adopt(freshJson); }
          setOut("✓ 已保存，下一次调用立即生效（不用重启）" + String.fromCharCode(10) + "文件：" + (j.configPath ?? ""));
        } catch (e) {
          setErr("保存失败：" + e.message);
        } finally { setBusy(""); }
      };

      if (data === null) {
        return h("div", { className: "dvw" },
          h("h3", { className: "dvw-title" }, "视频理解"),
          err ? h("div", { className: "dvw-err" }, err) : h("div", { className: "dvw-hint" }, "读取中…"));
      }

      const candidates = data.candidates ?? [];
      const resolved = data.resolved ?? {};
      const selectValue = customModel ? "__custom__" : draft.model;


      return h("div", { className: "dvw" },
        h("h3", { className: "dvw-title" }, "视频理解"),
        h("p", { className: "dvw-intro" },
          "画面 + 声音 + 时间轴 → 结构化结果。改完点保存就生效，不用重启。留空 = 用回落值（见每项提示）。"),

        h("div", { className: "dvw-group" }, "模型"),
        h("div", { className: "dvw-rows" },
          h(Row, {
            label: "视觉模型",
            hint: candidates.find((c) => c.value === (customModel ? "" : draft.model))?.note
              ?? "当前：" + (resolved.model ?? "—") + "。必须吃图；选错会在送图前明确报错，不会静默降级。",
          },
            h("select", {
              className: "dvw-select",
              value: selectValue,
              onChange: (e) => {
                const v = e.target.value;
                if (v === "__custom__") { setCustomModel(true); return; }
                setCustomModel(false);
                set("model", v);
              },
            },
              h("option", { value: "" }, "跟随默认（" + (resolved.model ?? "—") + "）"),
              candidates.map((c) => h("option", { key: c.value, value: c.value }, c.label)),
              h("option", { value: "__custom__" }, "自定义…")),
            customModel
              ? h("input", {
                className: "dvw-input dvw-wide",
                placeholder: "provider/model，例如 deepseek-account/deepseek-flash",
                value: draft.model,
                onChange: (e) => set("model", e.target.value),
              })
              : null),
          h(Row, {
            label: "默认档位",
            hint: "决定帧数、批大小与重采样轮数。工具调用时可以单独传 detail 覆盖这里。",
          },
            h("select", {
              className: "dvw-select",
              value: draft.detail,
              onChange: (e) => set("detail", e.target.value),
            },
              h("option", { value: "" }, "跟随默认（" + (resolved.detail ?? "—") + "）"),
              h("option", { value: "quick" }, "quick — 6 帧，先看一眼"),
              h("option", { value: "standard" }, "standard — 16 帧 + 1 轮重采样"),
              h("option", { value: "deep" }, "deep — 40 帧 + 2 轮重采样"))),
          h(Row, {
            label: "并发度",
            hint: "视觉批次 / whisper 分块同时在飞的请求上限。留空按 CPU 核数推导（当前 " + (resolved.concurrency ?? "—") + "）。",
          },
            h("input", {
              className: "dvw-input", type: "number", min: 1, max: 32,
              value: draft.concurrency,
              onChange: (e) => set("concurrency", e.target.value),
            })),
          h(Row, {
            label: "墙钟上限（分钟）",
            hint: "只管模型调用阶段。抽帧与转写不受它约束——抽帧影响帧数（不许降），转写中断等于丢工作。当前 " + minLabel(resolved.maxWallClockMs) + "。",
          },
            h("input", {
              className: "dvw-input", type: "number", min: 0.5, max: 60, step: 0.5, placeholder: "分钟，留空 = 5",
              value: draft.maxWallClockMs,
              onChange: (e) => set("maxWallClockMs", e.target.value),
            })),
          h(Row, { label: "音频语言", hint: "默认 zh。不要填 auto：中文靠自动检测会偶尔误判成粤语/日文。" },
            h("input", {
              className: "dvw-input",
              placeholder: "zh",
              value: draft.lang,
              onChange: (e) => set("lang", e.target.value),
            }))),


        h("details", null,
          h("summary", { className: "dvw-summary" }, "依赖路径（平时不用改）"),
          h("div", { className: "dvw-rows" },
            h(Row, { label: "ffmpeg", hint: "留空则按 DSH_VIDEO_FFMPEG > FFMPEG > $DSH_HOME 默认 > PATH 解析。" },
              h("input", { className: "dvw-input dvw-wide", value: draft.ffmpeg, placeholder: asText(resolved.ffmpeg), onChange: (e) => set("ffmpeg", e.target.value) })),
            h(Row, { label: "ffprobe", hint: "留空同上。" },
              h("input", { className: "dvw-input dvw-wide", value: draft.ffprobe, placeholder: asText(resolved.ffprobe), onChange: (e) => set("ffprobe", e.target.value) })),
            h(Row, { label: "whisper-cli", hint: "缺失只是没有转录（进 failures），画面分析照常。" },
              h("input", { className: "dvw-input dvw-wide", value: draft.whisperBin, placeholder: asText(resolved.whisperBin), onChange: (e) => set("whisperBin", e.target.value) })),
            h(Row, { label: "whisper 模型目录", hint: "放 ggml-*.bin 的目录。quick 档找 base，其余找 small。" },
              h("input", { className: "dvw-input dvw-wide", value: draft.whisperDir, placeholder: asText(resolved.whisperDir), onChange: (e) => set("whisperDir", e.target.value) })))),

        h("div", { className: "dvw-group" }, "当前实际生效"),
        h("div", { className: "dvw-rows" },
          h("div", { className: "dvw-row" },
            h("div", null,
              h("div", { className: "dvw-hint" }, "模型"),
              h("div", { className: "dvw-mono" }, asText(resolved.model))),
            h("div", null,
              h("div", { className: "dvw-hint" }, "档位 · 并发 · 墙钟"),
              h("div", { className: "dvw-mono" },
                asText(resolved.detail) + " · " + asText(resolved.concurrency) + " · " + minLabel(resolved.maxWallClockMs)))),
          h("div", { className: "dvw-row" },
            h("div", null,
              h("div", { className: "dvw-hint" }, "ffmpeg"),
              h("div", { className: "dvw-mono" }, asText(resolved.ffmpeg) || "（没找到）")),
            h("div", null,
              h("div", { className: "dvw-hint" }, "whisper"),
              h("div", { className: "dvw-mono" }, asText(resolved.whisperBin) || "（没找到，只有画面）")))),

        h("div", { className: "dvw-actions" },
          h("button", { className: "dvw-btn", onClick: save, disabled: !!busy }, busy === "save" ? "保存中…" : "保存"),
          h("button", { className: "dvw-btn dvw-btn2", onClick: load, disabled: !!busy }, "重新读取"),
          dirty ? h("span", { className: "dvw-dirty" }, "● 有改动还没保存") : null),

        err ? h("div", { className: "dvw-err" }, err) : null,
        out ? h("div", { className: "dvw-out" }, out) : null,
        h("div", { className: "dvw-hint" },
          "配置来源优先级：这个界面写的文件 > 环境变量 DSH_VIDEO_* > profile 里的 plugin config > 内置默认。"));
    }

    const inject = ["slots"];
    const SLOT_ID = "video";
    const NAV_LABEL = "视频理解";

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              { name: "settings.section", id: SLOT_ID, order: 7, label: () => NAV_LABEL },
              VideoSection,
            ),
            "dsh-video: settings section",
          ),
        "dsh-video: settings section",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.VideoSection = VideoSection;
    return module.exports;
  },
});

