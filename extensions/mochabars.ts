/**
 * bars-layout - restyles pi's TUI:
 *
 *   Bottom: two stacked bars on a darker (mantle) background, no gap between them.
 *     1. Prompt bar: subtle "❱" + the editor (autocomplete popups share the background).
 *     2. Status bar: subagent statuses + flat stats.
 *     The prompt "❱" shows state: green = ready, peach = working.
 *   Popups/modals that replace the editor (/tree, model selector, dialogs) get the bar
 *   background and sit directly above the status bar.
 *
 *   Transcript: a "┃" gutter (thin "│" in gaps) runs down the whole scroll area, colored by block type
 *   (default surface0, tools/thinking surface2, meta notes surface2, output green, prompt peach); exactly one
 *   blank row between blocks; tool calls collapse to one line (click / ctrl+e expands).
 *   shift+tab cycles a transcript filter: all -> assistant+prompts -> prompts only, snapping the
 *   first colored block on screen to the top (needs app.thinking.cycle unbound in keybindings.json).
 */

import {
	CustomEditor,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { matchesKey, Text, TruncatedText, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "os";

// ───────────────────────── catppuccin mocha ─────────────────────────
type RGB = readonly [number, number, number];
const MANTLE: RGB = [24, 24, 37]; // #181825 - bar background
const OVERLAY0: RGB = [108, 112, 134]; // #6c7086 - subtle text (status bar, tags)
const TEXT: RGB = [205, 214, 244]; // #cdd6f4
const GREEN: RGB = [166, 227, 161]; // #a6e3a1
const PEACH: RGB = [250, 179, 135]; // #fab387

const RESET = "\x1b[0m";
const fg = (c: RGB) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
const bg = (c: RGB) => `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`;
const BAR_BG = bg(MANTLE);

/** Re-open the bar background after any reset inside `s`, pad to width, close. */
function onBar(s: string, width: number): string {
	const padded = s + " ".repeat(Math.max(0, width - visibleWidth(s)));
	return BAR_BG + padded.replaceAll(RESET, RESET + BAR_BG).replaceAll("\x1b[49m", BAR_BG) + RESET;
}

function shortenPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

// ───────────────────────── transcript gutter ─────────────────────────
const GUTTER_W = 2;
// Centered vertical lines: heavy for blocks, thin line for the gap rows between them.
const gutter = (c: RGB) => `${fg(c)}┃${RESET} `;
const gapGutter = (c: RGB) => `${fg(c)}┃${RESET} `;
const SURFACE0: RGB = [49, 50, 68]; // #313244 - 1 shade above base
const G_DEFAULT = SURFACE0;
const G_TOOL = SURFACE0;
const G_THINKING = SURFACE0;
const G_OUTPUT = GREEN;
const G_PROMPT = PEACH;
const G_PROMPT_QUEUED: RGB = [125, 90, 68]; // dimmed peach - queued prompts not yet sent
const G_META = SURFACE0; // status notes, warnings, errors, "reloaded ..." etc.

const ANSI_RE = /\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x1b]*\x1b\\/g;
const isBlank = (line: string) => line.replace(ANSI_RE, "").trim() === "";
const hasImage = (lines: string[]) => lines.some((l) => l.includes("\x1b_G") || l.includes("\x1b]1337;"));

type Block = { comp: Component; color: RGB; tool?: boolean };
type Segment = { comp: Component; color: RGB; y0: number; trimTop: number; kept: number; height: number };

/**
 * Transcript filter, cycled with shift+tab:
 *   0 = all (greens, oranges, greys), 1 = greens + oranges, 2 = oranges only.
 * Shared between the document patch (rendering) and the shortcut handler (cycling + snap).
 */
const transcriptView = {
	mode: 0,
	doc: undefined as AnyComp | undefined,
	width: -1,
	segments: [] as Segment[],
};
const visibleIn = (mode: number, c: RGB) =>
	mode === 0 || c === G_PROMPT || c === G_PROMPT_QUEUED || (mode === 1 && c === G_OUTPUT);
const blockVisible = (c: RGB) => visibleIn(transcriptView.mode, c);

/**
 * Snapshot of the viewport at the user's last non-shift-tab action (scroll, click, typing).
 * Repeated shift+tab presses re-anchor against this snapshot instead of wherever the
 * previous press landed, so cycling through the modes is stable.
 */
const snapState = {
	blocks: [] as { comp: Component; color: RGB }[], // every block in document order
	first: 0, // index of the first block intersecting the viewport
	last: -1, // index of the last block intersecting the viewport
	fromBottom: 0,
	atBottom: false,
	scrollTop: -1, // scrollTop we left the view at; -1 = snapshot invalid
};
const isColored = (c: RGB) => c === G_OUTPUT || c === G_PROMPT || c === G_PROMPT_QUEUED;
const invalidateSnapshot = () => {
	snapState.scrollTop = -1;
};

type AnyComp = Component & { children?: Component[]; contentContainer?: { children: Component[] } };
const nameOf = (c: unknown) => (c as { constructor?: { name?: string } })?.constructor?.name ?? "";

/** Pi creates meta notes (status/warning/error) with 1 col of padding; strip it so they align with the gutter. */
function stripPadding(c: Component): Component {
	(c as unknown as { setPaddingX?: (p: number) => void }).setPaddingX?.(0);
	return c;
}

/** Split a transcript child into colored blocks. */
function blocksFor(child: AnyComp): Block[] {
	switch (nameOf(child)) {
		case "Spacer":
			return [];
		case "UserMessageComponent":
		case "SkillInvocationMessageComponent":
			return [{ comp: child, color: G_PROMPT }];
		case "ToolExecutionComponent":
		case "BashExecutionComponent":
			return [{ comp: child, color: G_TOOL, tool: true }];
		case "AssistantMessageComponent": {
			const parts = child.contentContainer?.children ?? [];
			const out: Block[] = [];
			for (const p of parts) {
				const n = nameOf(p);
				if (n === "Spacer") continue;
				if (n === "MouseRegion") out.push({ comp: p, color: G_THINKING }); // thinking run (clickable)
				else if (n === "Markdown") out.push({ comp: p, color: G_OUTPUT }); // assistant text
				else out.push({ comp: stripPadding(p), color: G_META }); // truncation / abort / error notices
			}
			return out;
		}
		default:
			// Anything else pi adds to the chat is a meta note (status, warning, error, notices).
			return [{ comp: stripPadding(child), color: G_META }];
	}
}

/**
 * Take over rendering of the transcript document: gutter on every row, one blank row
 * between blocks, mouse events remapped to the underlying components.
 */
function patchDocument(doc: AnyComp, chat: AnyComp): void {
	// Always (re)install: after /reload the new extension code must replace the old closures.
	let segments: Segment[] = [];
	let lastWidth = -1;

	doc.render = (width: number): string[] => {
		const inner = Math.max(1, width - GUTTER_W);
		const blocks: Block[] = [];
		for (const c of doc.children ?? []) {
			if (c === chat) for (const cc of chat.children ?? []) blocks.push(...blocksFor(cc as AnyComp));
			else blocks.push({ comp: c, color: G_DEFAULT });
		}

		const out: string[] = [];
		const segs: Segment[] = [];
		const gap = gapGutter(G_DEFAULT);
		let prevTool = false;
		for (const { comp, color, tool } of blocks) {
			if (!blockVisible(color)) continue;
			const lines = comp.render(inner);
			let start = 0;
			let end = lines.length;
			while (start < end && isBlank(lines[start]!)) start++;
			if (!hasImage(lines)) while (end > start && isBlank(lines[end - 1]!)) end--;
			if (start >= end) continue;
			if (out.length > 0 && !(prevTool && tool)) out.push(gap);
			prevTool = tool === true;
			segs.push({ comp, color, y0: out.length, trimTop: start, kept: end - start, height: lines.length });
			const g = gutter(color);
			for (let i = start; i < end; i++) out.push(g + lines[i]);
		}
		segments = segs;
		lastWidth = width;
		transcriptView.doc = doc;
		transcriptView.width = width;
		transcriptView.segments = segs;
		return out;
	};

	doc.handleMouse = (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
		invalidateSnapshot(); // user interacted with the transcript
		if (event.width !== lastWidth) doc.render(event.width);
		const seg = segments.find((s) => event.y >= s.y0 && event.y < s.y0 + s.kept);
		if (!seg || event.x < GUTTER_W) return undefined;
		return seg.comp.handleMouse?.({
			...event,
			x: event.x - GUTTER_W,
			y: event.y - seg.y0 + seg.trimTop,
			width: Math.max(1, event.width - GUTTER_W),
			height: seg.height,
		});
	};
}

/**
 * Queued steering / follow-up messages (dock, above the prompt bar): restyle pi's
 * "Steering: msg" rows into the transcript's gutter language.
 */
function patchPendingContainer(container: AnyComp): void {
	const store = container as unknown as { __barsOrigRender?: (w: number) => string[] };
	store.__barsOrigRender ??= container.render.bind(container);
	const originalRender = store.__barsOrigRender;

	container.render = (width: number): string[] => {
		const children = container.children ?? [];
		const queued = children.filter((c) => nameOf(c) === "TruncatedText") as unknown as { text: string }[];
		// Anything else (e.g. a running "!" bash command) keeps the default rendering.
		if (queued.length === 0 || queued.length + 1 !== children.length) {
			agentState.queued = 0;
			return originalRender(width);
		}

		const inner = Math.max(1, width - GUTTER_W);
		const out: string[] = [gapGutter(G_DEFAULT)];
		let count = 0;
		for (const { text } of queued) {
			const plain = text.replace(ANSI_RE, "");
			const m = plain.match(/^(Steering|Follow-up): ([\s\S]*)$/);
			if (!m) continue; // drop the "↳ alt+up ..." dequeue hint; the status bar reports it instead
			count++;
			const tag = m[1] === "Steering" ? "queue" : "queued";
			const msg = m[2]!.replace(/\s+/g, " ");
			const line = `${fg(G_PROMPT_QUEUED)}${tag}${RESET} ${fg(TEXT)}${msg}${RESET}`;
			out.push(gutter(G_PROMPT_QUEUED) + truncateToWidth(line, inner));
		}
		agentState.queued = count;
		return out;
	};
}

/** Popups/modals that replace the editor get the bar background. */
function patchEditorContainer(container: AnyComp, isPromptBar: (c: unknown) => boolean): void {
	// Keep the true original across /reload so patches never stack.
	const store = container as unknown as { __barsOrigRender?: (w: number) => string[] };
	store.__barsOrigRender ??= container.render.bind(container);
	const originalRender = store.__barsOrigRender;
	container.render = (width: number): string[] => {
		const lines = originalRender(width);
		const children = container.children ?? [];
		if (children.length === 1 && isPromptBar(children[0])) return lines;
		return lines.map((l) => onBar(l, width));
	};
}

// ───────────────────────── prompt bar editor ─────────────────────────
const TOP_SENTINEL = "\u0000bars-layout-top\u0000";
const BOTTOM_SENTINEL = "\u0000bars-layout-bottom\u0000";
const PREFIX_W = 2;
/** The fullscreen dock reserves minSize 3 rows for the editor slot; drop it to 1. */
function patchDockMinSize(tui: AnyComp, editorContainer: AnyComp): void {
	type Entry = { component: unknown; minSize?: number };
	const root = (tui as unknown as { layoutRoot?: { entries?: Entry[] } }).layoutRoot;
	for (const e of root?.entries ?? []) {
		const dock = e.component as { entries?: Entry[] };
		const slot = dock.entries?.find((d) => d.component === editorContainer);
		if (slot) slot.minSize = 1;
	}
}

/** Agent state shared between the extension (events) and the prompt bar (rendering). */
const agentState = { working: false, queued: 0 };

/**
 * Transient filter notice shown in the status bar: visible while shift is held
 * (polled via pi-tui's native platform helper), with a short timer fallback on
 * platforms where modifier state is unavailable.
 */
const filterNotice = { text: "", until: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined };

/**
 * pi-tui doesn't export native-modifiers from its index, and the extension loader
 * only aliases bare specifiers, so locate pi's node_modules from the running CLI
 * entry (process.argv[1] -> .../node_modules/.bin/pi) and load the module directly.
 */
let isShiftHeld: (() => boolean) | undefined;
(async () => {
	try {
		const { realpathSync } = await import("node:fs");
		const nodePath = await import("node:path");
		const { pathToFileURL } = await import("node:url");
		const entry = realpathSync(process.argv[1] ?? "");
		const nmIdx = entry.lastIndexOf(`${nodePath.sep}node_modules${nodePath.sep}`);
		if (nmIdx < 0) return;
		const modPath = nodePath.join(
			entry.slice(0, nmIdx),
			"node_modules",
			"@earendil-works",
			"pi-tui",
			"dist",
			"native-modifiers.js",
		);
		const mod = (await import(pathToFileURL(modPath).href)) as { isNativeModifierPressed?: (k: string) => boolean };
		if (typeof mod.isNativeModifierPressed !== "function") return;
		mod.isNativeModifierPressed("shift"); // probe: throws if the native helper is unusable
		isShiftHeld = () => mod.isNativeModifierPressed!("shift");
	} catch {
		// shift-hold detection unavailable; the notice falls back to a 1s timer
	}
})();
const noticeVisible = () =>
	filterNotice.text !== "" && (isShiftHeld ? isShiftHeld() : Date.now() < filterNotice.until);

class PromptBarEditor extends CustomEditor {
	private patched = false;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings, { paddingX: 0 });
	}

	protected override renderTopBorder(): string {
		return TOP_SENTINEL;
	}

	protected override renderBottomBorder(): string {
		return BOTTOM_SENTINEL;
	}

	/** Locate pi's containers once mounted: [document, pending, status, widgetsAbove, editor, widgetsBelow, footer]. */
	private patchLayout(): void {
		if (this.patched) return;
		const roots = ((this.tui as unknown as AnyComp).children ?? []) as AnyComp[];
		const editorContainer = roots.find((c) => c.children?.includes(this));
		const doc = roots[0];
		const chat = doc?.children?.[2] as AnyComp | undefined;
		if (!editorContainer || !doc || !chat) return; // not mounted yet; retry next render
		patchDocument(doc, chat);
		patchEditorContainer(editorContainer, (c) => c instanceof PromptBarEditor);
		const pending = roots[1];
		if (pending && pending !== editorContainer) patchPendingContainer(pending);
		patchDockMinSize(this.tui as unknown as AnyComp, editorContainer);
		this.patched = true;
		this.tui.requestRender();
	}

	override handleInput(data: string): void {
		// Typing resets the shift+tab anchor; shift+tab itself must not (the shortcut
		// may also pass through the editor depending on dispatch order).
		if (!matchesKey(data, "shift+tab")) invalidateSnapshot();
		super.handleInput(data);
	}

	override render(width: number): string[] {
		this.patchLayout();
		const inner = Math.max(10, width - PREFIX_W);
		const raw = super.render(inner);
		const out: string[] = [];
		let contentIndex = 0;
		for (const line of raw) {
			if (line === TOP_SENTINEL || line === BOTTOM_SENTINEL) continue;
			const head = contentIndex === 0 ? `${fg(agentState.working ? PEACH : GREEN)}❱ ${RESET}` : "  ";
			out.push(onBar(head + line, width));
			contentIndex++;
		}
		return out;
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// Base layout: top border row 0, content rows 1.., bottom border, autocomplete.
		// We dropped both borders and added a 2-col prefix.
		return super.handleMouse({
			...event,
			x: Math.max(0, event.x - PREFIX_W),
			y: event.y + 1,
			width: Math.max(1, event.width - PREFIX_W),
		});
	}
}

// ───────────────────────── extension ─────────────────────────
export default function (pi: ExtensionAPI) {
	let activeTui: TUI | undefined;
	agentState.working = false;

	pi.on("agent_start", () => {
		agentState.working = true;
		activeTui?.requestRender();
	});

	pi.on("agent_settled", () => {
		agentState.working = false;
		activeTui?.requestRender();
	});

	pi.on("session_shutdown", () => {
		activeTui = undefined;
	});

	// shift+tab: cycle transcript filter (all -> greens+oranges -> oranges only).
	// Requires keybindings.json to unbind app.thinking.cycle from shift+tab.
	pi.registerShortcut("shift+tab", {
		description: "Cycle transcript filter (all / chat / prompts)",
		handler: () => {
			// Transient notification: temporarily replaces the status bar content.
			const grey = (s: string) => `${fg(OVERLAY0)}${s}${RESET}`;
			const notices = [
				grey("filtered to all"),
				`${grey("filtered to ")}${fg(PEACH)}prompts${RESET}${grey(" and ")}${fg(GREEN)}responses${RESET}`,
				`${grey("filtered to ")}${fg(PEACH)}prompts${RESET}`,
			];
			const showNotice = (text: string) => {
				filterNotice.text = text;
				if (filterNotice.timer) clearInterval(filterNotice.timer);
				if (isShiftHeld) {
					// Visible while shift is held: poll and re-render; stop when released.
					filterNotice.timer = setInterval(() => {
						if (!isShiftHeld()) {
							clearInterval(filterNotice.timer!);
							filterNotice.timer = undefined;
							filterNotice.text = "";
						}
						activeTui?.requestRender();
					}, 100);
				} else {
					// Fallback: fixed 1s.
					filterNotice.until = Date.now() + 1000;
					filterNotice.timer = setTimeout(() => activeTui?.requestRender(), 1050);
				}
				filterNotice.timer.unref?.();
			};

			type SV = {
				scrollTop: number;
				viewportHeight: number;
				isFollowingEnd: boolean;
				scrollTo: (top: number, opts?: { disableFollow?: boolean }) => void;
				scrollToEnd: () => void;
				updateLayout: (contentHeight: number, viewportHeight: number, requestRender: () => void) => void;
			};
			const sv = (activeTui as unknown as { getPrimaryScrollView?: () => SV } | undefined)?.getPrimaryScrollView?.();
			const { doc, width } = transcriptView;
			const oldMode = transcriptView.mode;
			const newMode = (oldMode + 1) % 3;

			showNotice(notices[newMode]!);

			// No scroll context (not fullscreen / not laid out yet): just cycle the filter.
			if (!sv || !doc || width <= 0 || sv.viewportHeight <= 0) {
				transcriptView.mode = newMode;
				activeTui?.requestRender();
				return;
			}

			// 1. Snapshot: if the user scrolled, clicked, or typed since the last shift+tab
			//    (or this is the first press), capture the viewport in the CURRENT layout:
			//    the on-screen blocks top-to-bottom (anchor candidates) and the distance from
			//    the bottom of the content (for the fallback). Otherwise reuse the snapshot,
			//    so cycling re-anchors against where the user actually was.
			if (sv.scrollTop !== snapState.scrollTop) {
				const oldLines = doc.render(width); // refresh segments for the current mode
				const top = sv.scrollTop;
				const bottom = top + sv.viewportHeight;
				const segs = transcriptView.segments;
				snapState.blocks = segs.map((s) => ({ comp: s.comp, color: s.color }));
				snapState.first = segs.findIndex((s) => s.y0 + s.kept > top && s.y0 < bottom);
				snapState.last = segs.findLastIndex((s) => s.y0 + s.kept > top && s.y0 < bottom);
				snapState.fromBottom = Math.max(0, oldLines.length - bottom);
				snapState.atBottom = sv.isFollowingEnd || snapState.fromBottom === 0;
			}

			// 2. Apply the new filter.
			transcriptView.mode = newMode;
			const lines = doc.render(width);

			// 3. Sync the scroll view to the new content height BEFORE scrolling: scrollTo
			//    clamps against its stored contentHeight, which is stale (the TUI only calls
			//    updateLayout on its own layout passes).
			sv.updateLayout(lines.length, sv.viewportHeight, () => activeTui?.requestRender());

			// 4. Scroll. Snapshot taken at the bottom: stay snapped to the bottom in every
			//    mode (follow-end stays on). Otherwise anchor on the snapshot's first
			//    on-screen COLORED block. If the new mode hides it (e.g. a green response on
			//    top in prompts-only mode), walk BACKWARD to the nearest surviving block
			//    above - the prompt that produced it - so the conversation position is
			//    preserved instead of skipping ahead. Snap the anchor's first line to the
			//    top of the window; if it can't reach (or nothing anchors), go to the
			//    bottom of the content.
			if (snapState.atBottom) {
				sv.scrollToEnd();
			} else {
				const { blocks, first, last } = snapState;
				const survives = (i: number) => isColored(blocks[i]!.color) && visibleIn(newMode, blocks[i]!.color);
				let idx = -1;
				if (first >= 0) {
					let primary = -1; // first colored block on screen
					for (let i = first; i <= last; i++) {
						if (isColored(blocks[i]!.color)) {
							primary = i;
							break;
						}
					}
					if (primary >= 0 && survives(primary)) idx = primary;
					else {
						// Nearest surviving block above the viewport (or above the hidden primary).
						for (let i = (primary >= 0 ? primary : first) - 1; i >= 0; i--) {
							if (survives(i)) {
								idx = i;
								break;
							}
						}
						// Nothing above: fall forward to the next surviving block on screen.
						if (idx < 0 && primary >= 0) {
							for (let i = primary + 1; i <= last; i++) {
								if (survives(i)) {
									idx = i;
									break;
								}
							}
						}
					}
				}
				const anchor = idx >= 0 ? blocks[idx]!.comp : undefined;
				const seg = anchor && transcriptView.segments.find((s) => s.comp === anchor);
				const maxTop = Math.max(0, lines.length - sv.viewportHeight);
				if (seg && seg.y0 <= maxTop) {
					sv.scrollTo(seg.y0, { disableFollow: true });
				} else {
					// snapState.fromBottom is measured in the OLD layout's lines; applying it to
					// the new (often much shorter) layout used to clamp the target to 0 - the
					// top of the whole session. Bottom is the sane destination.
					sv.scrollTo(maxTop, { disableFollow: true });
				}
			}
			// Record where we left the view; a matching scrollTop on the next press means
			// "no user movement in between" and reuses the snapshot.
			snapState.scrollTop = sv.scrollTop;
			activeTui?.requestRender();
		},
	});

	// Headings: dithered shade prefix per level (▓ H1, ▒ H2, ░ H3+). H3+ are shown as H2 so pi doesn't print "### ".
	pi.registerMarkdownTransformer((markdown, { messageType }) => {
		if (messageType !== "assistant") return markdown;
		let fence: string | undefined;
		return markdown
			.split("\n")
			.map((line) => {
				const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
				if (f) {
					if (!fence) fence = f[1]![0]!;
					else if (f[1]![0] === fence) fence = undefined;
					return line;
				}
				if (fence) return line;
				const h = line.match(/^ {0,3}(#{1,6})[ \t]+(.*)$/);
				if (!h) return line;
				const depth = h[1]!.length;
				const level = Math.min(depth, 2);
				const shade = depth === 1 ? "▓" : depth === 2 ? "▒" : "░";
				return `${"#".repeat(level)} ${shade} ${h[2]}`;
			})
			.join("\n");
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Hide the standalone working row; the status bar reports it instead.
		ctx.ui.setWorkingVisible(false);

		// Prompt bar.
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			activeTui = tui;
			return new PromptBarEditor(tui, theme, keybindings);
		});

		// Status bar (footer), directly below the editor slot / any popup.
		ctx.ui.setFooter((tui, _theme, footerData) => {
			activeTui = tui;
			return {
				dispose() {},
				invalidate() {},
				render(width: number): string[] {
					// Transient filter notice temporarily replaces the whole status line.
					if (noticeVisible()) {
						return [onBar(truncateToWidth(filterNotice.text, width), width)];
					}

					// Small "filtering" indicator right after the session name while a filter is on:
					// alternating peach/green letters for prompts+responses, full peach for prompts.
					// Ends by restoring the bar's grey so the following segments keep their style.
					let filterTag = "";
					if (transcriptView.mode === 1) {
						filterTag = `${fg(PEACH)}fil${fg(GREEN)}ter${fg(OVERLAY0)}`;
					} else if (transcriptView.mode === 2) {
						filterTag = `${fg(PEACH)}filter${fg(OVERLAY0)}`;
					}

					// Flat stats first, extension/subagent statuses (e.g. tp:claude) at the end
					const usage = ctx.getContextUsage();
					const sessionName = ctx.sessionManager.getSessionName();
					const segments = [
						...(filterTag ? [filterTag] : []),
						shortenPath(ctx.cwd),
						...(sessionName ? [sessionName] : []),
						ctx.model ? ctx.model.id : "no model",
						pi.getThinkingLevel(),
						`${usage?.percent != null ? Math.round(usage.percent) : "?"}%`,
						...footerData.getExtensionStatuses().values(),
						...(agentState.queued > 0 ? [`${fg(PEACH)}${agentState.queued} queued (⌥↑ edit)${RESET}`] : []),
					];
					const line = `${fg(OVERLAY0)}${segments.join(" ")}${RESET}`;

					return [onBar(truncateToWidth(line, width), width)];
				},
			};
		});
	});

	// ───────────────────── one-line boxy tool calls ─────────────────────
	const cwd = process.cwd();
	// The transcript gutter provides the boxy indent; calls are a single line.
	const title = (theme: ExtensionContext["ui"]["theme"], name: string) => theme.fg("toolTitle", name);

	/** Tool call line: cut off at the terminal width; wraps only when expanded (click / ctrl+e). */
	const callLine = (text: string, context: { expanded: boolean }) =>
		context.expanded ? new Text(text, 0, 0) : new TruncatedText(text, 0, 0);

	const collapsedEmpty = new Text("", 0, 0);

	const expandedOutput = (result: { content: { type: string; text?: string }[] }, theme: ExtensionContext["ui"]["theme"]) => {
		const textContent = result.content.find((c) => c.type === "text");
		if (!textContent?.text) return collapsedEmpty;
		const out = textContent.text
			.trimEnd()
			.split("\n")
			.map((l) => `  ${theme.fg("toolOutput", l)}`)
			.join("\n");
		return new Text(out, 0, 0);
	};

	const errorLine = (result: { content: { type: string; text?: string }[] }, theme: ExtensionContext["ui"]["theme"]) => {
		const textContent = result.content.find((c) => c.type === "text");
		if (textContent?.text && /^error/i.test(textContent.text)) {
			return new Text(`  ${theme.fg("error", textContent.text.split("\n")[0]!)}`, 0, 0);
		}
		return undefined;
	};

	// read
	pi.registerTool({
		...createReadToolDefinition(cwd),
		renderCall(args: { path?: string; offset?: number; limit?: number }, theme, context) {
			let text = `${title(theme, "read")} ${theme.fg("muted", shortenPath(args.path ?? "..."))}`;
			if (args.offset || args.limit) text += theme.fg("dim", ` :${args.offset ?? 1}+${args.limit ?? ""}`);
			return callLine(text, context);
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) return errorLine(result, theme) ?? collapsedEmpty;
			return expandedOutput(result, theme);
		},
	});

	// bash
	pi.registerTool({
		...createBashToolDefinition(cwd),
		renderCall(args: { command?: string }, theme, context) {
			// Collapsed: one line. Expanded: the command as written, newlines included.
			const raw = args.command ?? "...";
			const cmd = context.expanded ? raw : raw.replace(/\s+/g, " ");
			const body = cmd.split("\n").map((l) => theme.fg("muted", l)).join("\n");
			return callLine(`${title(theme, "bash")} ${body}`, context);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial && !expanded) return collapsedEmpty;
			if (!expanded) return errorLine(result, theme) ?? collapsedEmpty;
			return expandedOutput(result, theme);
		},
	});

	// edit
	pi.registerTool({
		...createEditToolDefinition(cwd),
		renderCall(args: { path?: string }, theme, context) {
			let text = `${title(theme, "edit")} ${theme.fg("muted", shortenPath(args.path ?? "..."))}`;
			const stats = (context.state ?? {}) as { diffStats?: string };
			if (stats.diffStats) text += ` ${stats.diffStats}`;
			return callLine(text, context);
		},
		renderResult(result, { expanded }, theme, context) {
			const details = result.details as { diff?: string } | undefined;
			if (!expanded) {
				const err = errorLine(result, theme);
				if (err) return err;
				if (!details?.diff) return collapsedEmpty;
				let add = 0;
				let del = 0;
				for (const l of details.diff.split("\n")) {
					if (l.startsWith("+") && !l.startsWith("+++")) add++;
					if (l.startsWith("-") && !l.startsWith("---")) del++;
				}
				// Show +N -N inline, to the right of the filename on the call line.
				const stats = (context.state ??= {}) as { diffStats?: string };
				const rendered = `${theme.fg("success", `+${add}`)} ${theme.fg("error", `-${del}`)}`;
				if (stats.diffStats !== rendered) {
					stats.diffStats = rendered;
					context.invalidate();
				}
				return collapsedEmpty;
			}
			if (!details?.diff) return expandedOutput(result, theme);
			const diff = details.diff
				.split("\n")
				.map((l) => {
					if (l.startsWith("+") && !l.startsWith("+++")) return `  ${theme.fg("toolDiffAdded", l)}`;
					if (l.startsWith("-") && !l.startsWith("---")) return `  ${theme.fg("toolDiffRemoved", l)}`;
					return `  ${theme.fg("toolDiffContext", l)}`;
				})
				.join("\n");
			return new Text(diff, 0, 0);
		},
	});

	// write
	pi.registerTool({
		...createWriteToolDefinition(cwd),
		renderCall(args: { path?: string; content?: string }, theme, context) {
			const lines = args.content ? ` ${theme.fg("dim", `(${args.content.split("\n").length} lines)`)}` : "";
			return callLine(`${title(theme, "write")} ${theme.fg("muted", shortenPath(args.path ?? "..."))}${lines}`, context);
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) return errorLine(result, theme) ?? collapsedEmpty;
			return expandedOutput(result, theme);
		},
	});

	// find / grep / ls: call line + count when collapsed
	const countCollapsed = (result: { content: { type: string; text?: string }[] }, theme: ExtensionContext["ui"]["theme"], noun: string) => {
		const textContent = result.content.find((c) => c.type === "text");
		const count = textContent?.text?.trim() ? textContent.text.trim().split("\n").length : 0;
		return new Text(`  ${theme.fg("dim", `→ ${count} ${noun}`)}`, 0, 0);
	};

	pi.registerTool({
		...createFindToolDefinition(cwd),
		renderCall(args: { pattern?: string; path?: string }, theme, context) {
			return callLine(`${title(theme, "find")} ${theme.fg("muted", args.pattern ?? "")} ${theme.fg("dim", shortenPath(args.path ?? "."))}`, context);
		},
		renderResult(result, { expanded }, theme) {
			return expanded ? expandedOutput(result, theme) : countCollapsed(result, theme, "files");
		},
	});

	pi.registerTool({
		...createGrepToolDefinition(cwd),
		renderCall(args: { pattern?: string; path?: string }, theme, context) {
			return callLine(`${title(theme, "grep")} ${theme.fg("muted", `/${args.pattern ?? ""}/`)} ${theme.fg("dim", shortenPath(args.path ?? "."))}`, context);
		},
		renderResult(result, { expanded }, theme) {
			return expanded ? expandedOutput(result, theme) : countCollapsed(result, theme, "matches");
		},
	});

	pi.registerTool({
		...createLsToolDefinition(cwd),
		renderCall(args: { path?: string }, theme, context) {
			return callLine(`${title(theme, "ls")} ${theme.fg("muted", shortenPath(args.path ?? "."))}`, context);
		},
		renderResult(result, { expanded }, theme) {
			return expanded ? expandedOutput(result, theme) : countCollapsed(result, theme, "entries");
		},
	});
}
