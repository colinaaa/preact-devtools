import { Fragment, h, options, render } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { expect } from "vitest";
import { setupOptionsV10 } from "./options";
import { createRenderer } from "../shared/renderer";
import { bindingsV10 } from "./bindings";
import { newProfiler } from "../adapter/profiler";
import { createIdMappingState } from "../shared/idMapper";
import { toSnapshot } from "../debug";

describe("setupOptionsV10", () => {
	describe("_root hook (root container detection)", () => {
		// Regression test for the ReactLynx host where `globalThis.Node` is
		// undefined but `lynx.preactDevtoolsCtx.Node` is shimmed with the
		// `BackgroundSnapshotInstance` constructor (`react-lynx/setup.ts`).
		// The `__root` snapshot has no `parentNode`, so the old guard
		// `"Node" in globalThis && parent instanceof lynx.preactDevtoolsCtx.Node`
		// fell through to `parent.parentNode`, set `userRootToContainer`
		// to `null`, and `_commit` skipped `roots.set(vnode, dom)`. That
		// left `getRootMappings()` permanently empty -- breaking
		// `refresh` / `applyFilters` / `root-order-page` even after the
		// `document.body` shim landed.
		it("treats a lynx.preactDevtoolsCtx.Node container as the root container, even with no globalThis.Node and no parentNode", () => {
			const hadGlobalNode = Object.prototype.hasOwnProperty.call(
				globalThis,
				"Node",
			);
			const originalGlobalNode = (globalThis as any).Node;
			const hadCtxNode = Object.prototype.hasOwnProperty.call(
				lynx.preactDevtoolsCtx,
				"Node",
			);
			const originalCtxNode = lynx.preactDevtoolsCtx.Node;

			// Reproduce the ReactLynx Background VM environment:
			// `globalThis.Node` is missing and the application root has no
			// parent. We build a custom Node-like base class so we can
			// instantiate parent-less containers (jsdom `Node`s always
			// keep a real parent chain and would not exercise the bug).
			class FakeBackgroundSnapshotInstance {
				childNodes: FakeBackgroundSnapshotInstance[] = [];
				parentNode: FakeBackgroundSnapshotInstance | null = null;
				nodeName = "ROOT";
				appendChild(child: FakeBackgroundSnapshotInstance) {
					child.parentNode = this;
					this.childNodes.push(child);
					return child;
				}
				insertBefore(
					child: FakeBackgroundSnapshotInstance,
					_ref: FakeBackgroundSnapshotInstance | null,
				) {
					return this.appendChild(child);
				}
				removeChild(child: FakeBackgroundSnapshotInstance) {
					const idx = this.childNodes.indexOf(child);
					if (idx >= 0) this.childNodes.splice(idx, 1);
					child.parentNode = null;
					return child;
				}
			}

			lynx.preactDevtoolsCtx.Node = FakeBackgroundSnapshotInstance as any;
			delete (globalThis as any).Node;

			try {
				const fakeRoot = new FakeBackgroundSnapshotInstance();

				// We do not run a full Preact mount here because Preact 10
				// expects a real DOM-ish node with the browser createElement
				// surface. Instead we drive the option hooks directly with
				// shapes that match what Preact would pass: `_root` reports
				// the container, then `_commit` reports the matching root
				// VNode.
				const events: Array<[string, unknown]> = [];
				const roots = new Map();
				const renderer = createRenderer(
					{
						send: (type, data) => {
							events.push([type, data]);
						},
						listen: () => {},
						listenToPage: () => {},
					},
					{ Fragment: Fragment as any },
					options,
					{ hooks: false, renderReasons: false },
					newProfiler(),
					{ type: new Set(), regex: [] },
					createIdMappingState(1, bindingsV10.getInstance),
					bindingsV10,
					roots,
					"",
				);
				const destroy = setupOptionsV10(options, renderer, roots, {
					Fragment: Fragment as any,
				});

				try {
					const o = options as any;

					// Reproduce the call sequence Preact 10 emits during a
					// successful mount. `_root` is invoked with the *user*
					// vnode and the container DOM (`render(<App/>, container)`),
					// then `_commit` is invoked with the synthetic Fragment
					// root that wraps the user vnode.
					const childVNode: any = {
						type: "div",
						props: { children: null },
						_children: [],
						__k: [],
						_parent: null,
						__: null,
						_component: null,
						__c: null,
						_dom: new FakeBackgroundSnapshotInstance(),
						__e: undefined,
					};
					childVNode.__e = childVNode._dom;

					const rootVNode: any = {
						type: Fragment,
						props: { children: childVNode },
						_children: [childVNode],
						__k: [childVNode],
						_parent: null,
						__: null,
						_component: null,
						__c: null,
					};
					childVNode._parent = rootVNode;
					childVNode.__ = rootVNode;

					(o._root || o.__).call(o, childVNode, fakeRoot);
					(o._commit || o.__c).call(o, rootVNode, []);

					expect(roots.size).to.equal(
						1,
						"the root vnode must be tracked in `roots` after commit",
					);

					const mappings = renderer.getRootMappings();
					expect(mappings.length).to.equal(
						1,
						"`getRootMappings` is what `applyFilters` and `root-order-page` consume",
					);
					expect(mappings[0].node).to.equal(
						fakeRoot,
						"the parentless container must be used as-is, not its (null) parentNode",
					);
				} finally {
					destroy();
				}
			} finally {
				// Restore both globals exactly to their pre-test shape. A
				// plain reassignment would leave an own `Node` property set
				// to `undefined` when the property never existed (the
				// ReactLynx test setup is exactly that case), which would
				// make `"Node" in globalThis` true for subsequent tests and
				// break `instanceof Node` callers.
				if (hadGlobalNode) {
					(globalThis as any).Node = originalGlobalNode;
				} else {
					delete (globalThis as any).Node;
				}
				if (hadCtxNode) {
					lynx.preactDevtoolsCtx.Node = originalCtxNode;
				} else {
					delete (lynx.preactDevtoolsCtx as any).Node;
				}
			}
		});

		it("deduplicates stale Fragment roots when runWithForceRootRender clones the user root and a subsequent setState adds children", () => {
			const scratch = document.createElement("div");
			document.body.appendChild(scratch);

			const events: Array<[string, unknown]> = [];
			const roots = new Map();
			const renderer = createRenderer(
				{
					send: (type, data) => {
						events.push([type, data]);
					},
					listen: () => {},
					listenToPage: () => {},
				},
				{ Fragment: Fragment as any },
				options,
				{ hooks: false, renderReasons: false },
				newProfiler(),
				{ type: new Set(["dom", "fragment"]), regex: [] },
				createIdMappingState(1, bindingsV10.getInstance),
				bindingsV10,
				roots,
				"",
			);
			const destroy = setupOptionsV10(options, renderer, roots, {
				Fragment: Fragment as any,
			});

			try {
				let showSeparator!: (next: boolean) => void;
				function Separator() {
					return <hr />;
				}
				function App() {
					const [visible, setVisible] = useState(false);
					showSeparator = setVisible;
					return <div>{visible ? <Separator /> : null}</div>;
				}

				// 1. Initial mount (`root.render(<App />, __root)`):
				let rootJsx: any = <App />;
				render(rootJsx, scratch);
				expect(roots.size).to.equal(1);

				// 2. Reproduce ReactLynx `runWithForceRootRender` (`tt.updateGlobalProps`):
				// clones `__root.__jsx`, bumps `_original` (`__v`), forces component
				// diffing, and calls `render(__root.__jsx, __root)` on the same container.
				// Without container root deduplication, `roots` retains the initial
				// Fragment root alongside the new Fragment root.
				const clonedJsx = Object.assign({}, rootJsx);
				if (
					"_original" in clonedJsx &&
					typeof clonedJsx._original === "number"
				) {
					clonedJsx._original += 1;
				}
				if ("__v" in clonedJsx && typeof clonedJsx.__v === "number") {
					clonedJsx.__v += 1;
				}
				rootJsx = clonedJsx;

				render(rootJsx, scratch);

				expect(roots.size).to.equal(
					1,
					"`roots` must replace the container's previous Fragment root instead of keeping a stale entry",
				);
				expect(renderer.getRootMappings().length).to.equal(1);

				// 3. A subsequent state update mounts `<Separator />` into the live
				// component tree while the replaced Fragment's detached child still
				// holds the pre-setState `_children` array without `<Separator />`.
				act(() => {
					showSeparator(true);
				});

				// 4. `refresh()` walks `roots` to re-emit the component tree. With
				// stale roots evicted, it emits only the single live tree including
				// `<Separator />` rather than racing a stale snapshot against it.
				events.length = 0;
				renderer.refresh?.();

				const opEvents = events.filter(([type]) => type === "operation_v2");
				// Exactly 1 unmount flush + 1 mount flush for the single live root.
				expect(opEvents.length).to.equal(2);

				const mountSnapshot = toSnapshot(opEvents[1][1] as number[]);
				expect(mountSnapshot.some(line => line.includes("<App>"))).to.equal(
					true,
				);
				expect(
					mountSnapshot.some(line => line.includes("<Separator>")),
				).to.equal(true);
			} finally {
				render(null, scratch);
				expect(roots.size).to.equal(
					0,
					"unmounting with `render(null, container)` must also clear the container's tracked root",
				);
				destroy();
				scratch.remove();
			}
		});

		it("keeps separate virtual island roots that share the same parent DOM element", () => {
			const host = document.createElement("div");
			const marker1 = document.createElement("span");
			const marker2 = document.createElement("span");
			host.appendChild(marker1);
			host.appendChild(marker2);
			document.body.appendChild(host);

			function createVirtualContainer(parent: HTMLElement, replaceNode: Node) {
				const next = replaceNode.nextSibling;
				const insert = (child: Node, ref: Node | null) =>
					parent.insertBefore(child, ref || next);
				return {
					nodeType: 1,
					parentNode: parent,
					firstChild: replaceNode,
					childNodes: [replaceNode],
					insertBefore: insert,
					appendChild: insert,
					removeChild: (child: Node) => parent.removeChild(child),
					contains: (child: Node) => parent.contains(child),
				} as unknown as Element;
			}

			const roots = new Map();
			const renderer = createRenderer(
				{ send: () => {}, listen: () => {}, listenToPage: () => {} },
				{ Fragment: Fragment as any },
				options,
				{ hooks: false, renderReasons: false },
				newProfiler(),
				{ type: new Set(), regex: [] },
				createIdMappingState(1, bindingsV10.getInstance),
				bindingsV10,
				roots,
				"",
			);
			const destroy = setupOptionsV10(options, renderer, roots, {
				Fragment: Fragment as any,
			});

			try {
				const IslandA = () => <p>A</p>;
				const IslandB = () => <p>B</p>;
				const virtualA = createVirtualContainer(host, marker1);
				const virtualB = createVirtualContainer(host, marker2);

				render(<IslandA />, virtualA);
				render(<IslandB />, virtualB);

				expect(roots.size).to.equal(2);
				expect(renderer.getRootMappings().map(m => m.node)).to.deep.equal([
					host,
					host,
				]);
			} finally {
				destroy();
				host.remove();
			}
		});
	});
});
