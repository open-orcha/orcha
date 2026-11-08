import { describe, expect, it } from "vitest";
import { buildExplorationTree, describeAction, layoutTree, type Evidence, type Step } from "./tree-model";

let seq = 0;
function screen(hash: string, fg = "https://shop.test"): Step {
  seq += 1;
  return {
    seq,
    at_ms: seq * 1000,
    kind: "screen",
    args: {},
    result: null,
    screen_hash: hash,
    foreground: fg,
    frame_path: `r/frames/${String(seq).padStart(4, "0")}.jpg`,
  };
}
function tap(label: string): Step {
  seq += 1;
  return {
    seq,
    at_ms: seq * 1000,
    kind: "tap",
    args: { target: { index: 3 }, sig: { type: "Link", label } },
    result: "tapped",
    screen_hash: null,
    foreground: null,
    frame_path: null,
  };
}
function press(key: string): Step {
  seq += 1;
  return {
    seq,
    at_ms: seq * 1000,
    kind: "press",
    args: { key },
    result: null,
    screen_hash: null,
    foreground: null,
    frame_path: null,
  };
}

describe("buildExplorationTree", () => {
  it("builds a tree from a depth-first walk with back-outs", () => {
    seq = 0;
    const steps = [
      screen("home"),
      tap("Pricing"),
      screen("pricing"),
      tap("Enterprise"),
      screen("enterprise"),
      press("back"),
      screen("pricing"),
      press("home"),
      screen("home"),
      tap("Customers"),
      screen("customers"),
    ];
    const tree = buildExplorationTree(steps);
    expect(tree.rootId).toBe("home");
    const byId = new Map(tree.nodes.map((n) => [n.id, n]));
    expect(byId.get("home")!.name).toBe("shop.test");
    expect(byId.get("pricing")).toMatchObject({ parentId: "home", depth: 1, name: "Pricing", via: 'tap "Pricing"' });
    expect(byId.get("enterprise")).toMatchObject({ parentId: "pricing", depth: 2 });
    expect(byId.get("customers")).toMatchObject({ parentId: "home", depth: 1 });
    expect(byId.get("home")!.childIds).toEqual(["pricing", "customers"]);
    // Backing out adds no node; it is a revisit along the existing tree edge, or a return edge.
    expect(tree.nodes).toHaveLength(4);
    expect(byId.get("pricing")!.visits).toHaveLength(2);
    expect(tree.edges.filter((e) => e.kind === "tree")).toHaveLength(3);
    expect(tree.edges.filter((e) => e.kind === "return")).toHaveLength(0);
    expect(tree.journey.map((j) => j.nodeId)).toEqual(["home", "pricing", "enterprise", "pricing", "home", "customers"]);
  });

  it("records a jump to a non-parent screen as a return edge", () => {
    seq = 0;
    const steps = [
      screen("home"),
      tap("A"),
      screen("a"),
      tap("B"),
      screen("b"),
      tap("C"),
      screen("c"),
      tap("A again"),
      screen("a"),
    ];
    const tree = buildExplorationTree(steps);
    const ret = tree.edges.filter((e) => e.kind === "return");
    expect(ret).toEqual([expect.objectContaining({ source: "c", target: "a", label: 'tap "A again"' })]);
  });

  it("does not add a move when the screen hash is unchanged", () => {
    seq = 0;
    const tree = buildExplorationTree([screen("home"), tap("Nothing"), screen("home")]);
    expect(tree.nodes).toHaveLength(1);
    expect(tree.nodes[0].visits).toHaveLength(2);
    expect(tree.journey).toHaveLength(1);
  });

  it("attaches evidence to the screen the agent was on", () => {
    seq = 0;
    const steps = [screen("home"), tap("Login"), screen("login"), tap("Submit")];
    const ev: Evidence[] = [
      { seq: 4, severity: "minor", label: "No feedback" },
      { seq: 4, severity: "major", label: "Crash" },
    ];
    const tree = buildExplorationTree(steps, ev);
    const login = tree.nodes.find((n) => n.id === "login")!;
    expect(login.findings).toHaveLength(2);
    expect(login.worst).toBe("major");
  });

  it("is empty for a run with no screens", () => {
    expect(buildExplorationTree([])).toEqual({ nodes: [], edges: [], journey: [], rootId: null });
  });
});

function pageScreen(hash: string, url: string, title: string): Step {
  const st = screen(hash);
  st.args = { page: { url, title } };
  return st;
}
function swipe(): Step {
  seq += 1;
  return { seq, at_ms: seq * 1000, kind: "swipe", args: { direction: "up" }, result: null, screen_hash: null, foreground: null, frame_path: null };
}

describe("page grouping", () => {
  it("groups screens with the same page URL into one node, named by title", () => {
    seq = 0;
    const tree = buildExplorationTree([
      pageScreen("h1", "https://shop.test/", "Shop – Home"),
      swipe(),
      pageScreen("h2", "https://shop.test/", "Shop – Home"),
      tap("Pricing"),
      pageScreen("h3", "https://shop.test/pricing", "Pricing – Shop"),
      tap("Yearly"),
      pageScreen("h4", "https://shop.test/pricing", "Pricing – Shop"),
    ]);
    expect(tree.nodes.map((n) => [n.id, n.name, n.visits.length])).toEqual([
      ["https://shop.test/", "Shop", 2],
      ["https://shop.test/pricing", "Pricing", 2],
    ]);
    expect(tree.journey).toHaveLength(2);
  });

  it("without a URL, a scroll keeps the agent on the same node", () => {
    seq = 0;
    const tree = buildExplorationTree([screen("a"), swipe(), screen("a-scrolled"), tap("Next"), screen("b"), press("back"), screen("a-scrolled")]);
    expect(tree.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(tree.nodes[0].visits).toHaveLength(3);
  });
});

describe("global navigation", () => {
  it("attaches a page reached from the first screen's nav to the root, not the current page", () => {
    seq = 0;
    const home = screen("home");
    home.args = { anchors: ["Pricing", "Customers", "Log in"] };
    const tree = buildExplorationTree([home, tap("Pricing"), screen("pricing"), tap("Customers"), screen("customers"), tap("Story"), screen("story")]);
    const byId = new Map(tree.nodes.map((n) => [n.id, n]));
    expect(byId.get("customers")!.parentId).toBe("home");
    expect(byId.get("story")!.parentId).toBe("customers");
    // The move itself still happened from Pricing: it is drawn as a jump in the journey.
    expect(tree.journey.map((j) => j.nodeId)).toEqual(["home", "pricing", "customers", "story"]);
  });
});

describe("duplicate titles", () => {
  it("adds the path to pages that share a title", () => {
    seq = 0;
    const tree = buildExplorationTree([
      pageScreen("h1", "https://shop.test/", "Shop"),
      tap("Log in"),
      pageScreen("h2", "https://shop.test/login", "Shop"),
    ]);
    expect(tree.nodes.map((n) => n.name)).toEqual(["Shop · shop.test", "Shop · /login"]);
  });
});

describe("system screens", () => {
  it("skips the iOS home screen so the app's first screen is the root", () => {
    seq = 0;
    const tree = buildExplorationTree([screen("sb", "com.apple.springboard"), screen("app", "com.shop.app"), tap("Cart"), screen("cart", "com.shop.app")]);
    expect(tree.rootId).toBe("app");
    expect(tree.nodes.map((n) => n.id)).toEqual(["app", "cart"]);
  });
});

describe("describeAction", () => {
  it("names opens by path", () => {
    expect(
      describeAction({ kind: "launch", args: { bundle_id: "https://shop.test/missing" }, result: null }),
    ).toBe("open /missing");
  });
});

describe("layoutTree", () => {
  it("centres parents over their children, one row per depth", () => {
    seq = 0;
    const tree = buildExplorationTree([
      screen("root"),
      tap("A"),
      screen("a"),
      press("back"),
      screen("root"),
      tap("B"),
      screen("b"),
    ]);
    const pos = layoutTree(tree, 100, 200, 20);
    expect(pos.get("a")).toEqual({ x: 0, y: 200 });
    expect(pos.get("b")).toEqual({ x: 120, y: 200 });
    expect(pos.get("root")).toEqual({ x: 60, y: 0 });
  });
});

describe("screens whose accessibility tree was unavailable", () => {
  it("keys them by the frame digest so they do not collapse into one node", () => {
    seq = 0;
    const EMPTY = "da39a3ee5e6b"; // every empty tree hashes the same
    const look = (digest: string): Step => ({
      ...screen(EMPTY, "unknown (?)"),
      args: { tree_unavailable: true, frame_digest: digest },
    });
    const tree = buildExplorationTree([look("aaaa"), tap("Library"), look("bbbb"), tap("Videos"), look("cccc")]);
    expect(tree.nodes.length).toBe(3);
    expect(tree.nodes[0].name).toBe("Start");
    expect(tree.nodes.map((n) => n.name)).not.toContain("unknown (?)");
  });
});
