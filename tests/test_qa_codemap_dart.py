"""Flutter apps on the QA map (`orcha_cli.qa.codemap.code_dart`, ported from the original's
`tests/unit/app_map/test_app_map_code_dart.py`): the screens a Dart app declares (routes, page routes, screen names, tabs), the moves
between them, and the words each one shows, on small fixture repos shaped like the real ones
(ILM For You: Navigator 1.0 with an `onGenerateRoute` switch and a tab dashboard; a GoRouter app;
auto_route and GetX)."""

from __future__ import annotations

from pathlib import Path

import pytest

from orcha_cli.qa.codemap import features as fm
from orcha_cli.qa.codemap import code, code_dart
from orcha_cli.qa.codemap.payload import counts, payload_from_facts
from orcha_cli.qa.codemap.code_texts import ui_text

PUBSPEC = "name: shop\nenvironment:\n  sdk: '>=3.5.0 <4.0.0'\ndependencies:\n  flutter:\n    sdk: flutter\n"


def _tree(root: Path, files: dict[str, str]) -> Path:
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    return root


def _screens(facts: code.CodeFacts) -> dict[str, code.CodeScreen]:
    return {s.key: s for s in facts.screens}


def _labels(facts: code.CodeFacts) -> dict[tuple[str, str], set[str]]:
    out: dict[tuple[str, str], set[str]] = {}
    for n in facts.navigation:
        out.setdefault((n.from_key, n.to_key), set()).add(n.label)
    return out


def _texts(facts: code.CodeFacts) -> dict[str, object]:
    return {t.key: t for t in facts.texts}


# ---------- reading Dart ----------


def test_literals_read_dart_strings():
    src = (
        "final a = 'It\\'s here'; // 'not a string'\n"
        "final b = \"Hello $name, ${user.first} left\";\n"
        "final c = r'raw $x \\n';\n"
        "final d = '''Line one\nline two''';\n"
        "/* outer /* nested 'x' */ still */ final e = 'Joined ' 'words';\n"
    )
    values = [v for _, _, v in code_dart.literals(src)]
    assert values == ["It's here", f"Hello {code_dart.HOLE}, {code_dart.HOLE} left", "raw $x \\n", "Line one\nline two", "Joined words"]
    blank = code_dart.code_only(src)
    assert len(blank) == len(src) and "not a string" not in blank and "nested" not in blank and "Hello" not in blank


def test_an_icu_plural_reads_as_its_other_branch():
    assert code_dart._message("{count, plural, =1{1 resource} other{{count} resources}}") == f"{code_dart.HOLE} resources"
    assert code_dart._message("{n, plural, one{# item} other{# items}}") == f"{code_dart.HOLE} items"
    assert code_dart._message("Page {page}") == f"Page {code_dart.HOLE}"


def test_a_dart_package_without_flutter_has_no_screens(tmp_path):
    root = _tree(tmp_path, {
        "pubspec.yaml": "name: cli\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\n",
        "lib/home_screen.dart": "class HomeScreen extends StatelessWidget {}\n",
    })
    assert code.extract(root).screens == ()


# ---------- Navigator 1.0: an onGenerateRoute switch, page routes and tabs ----------

NAVIGATOR_APP = {
    "mobile/pubspec.yaml": PUBSPEC,
    "mobile/lib/l10n/intl_en.arb": '{"@@locale": "en", "home": "Home", "tabLibrary": "Library", "searchTooltip": "Search",'
                                   ' "seeAll": "View All", "itemsCount": "{count} resources", "@home": {"description": "x"}}',
    "mobile/lib/l10n/intl_so.arb": '{"home": "Hoyga"}',
    "mobile/lib/routes.dart": """
import 'package:flutter/material.dart';

class Routes {
  Routes._();
  static const splash = '/';
  static const dashboard = '/dashboard';
  static const libraryCategory = '/library/category';
  static const bookmarks = '/bookmarks';
  static const pdfViewer = '/library/pdf';
}

Route<dynamic> generatedRoutes(RouteSettings settings) {
  return CupertinoPageRoute(builder: (_) => _buildScreen(settings), settings: settings);
}

Widget _buildScreen(RouteSettings settings) {
  switch (settings.name) {
    case Routes.splash:
      return const SplashScreen();
    case Routes.dashboard:
      return const DashboardScreen();
    case Routes.libraryCategory:
      return OpenSourceScope(source: 'library', child: LibraryCategoryScreen(slug: _slug(settings)));
    case Routes.bookmarks:
    case '/saved':
      return const BookmarksScreen();
    default:
      return Scaffold(body: Text('Route not implemented yet'));
  }
}
""",
    "mobile/lib/splash_screen.dart": """
class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});
  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  void _go() => Navigator.of(context).pushReplacementNamed(Routes.dashboard);
  @override
  Widget build(BuildContext context) => const Text('Loading your library');
}
""",
    "mobile/lib/analytics/open_source_scope.dart": "class OpenSourceScope extends InheritedWidget {}\n",
    "mobile/lib/features/dashboard/view/dashboard.dart": """
class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  static const _tabs = <Widget>[
    OpenSourceScope(source: 'home', child: HomeTab()),
    LibraryTab(),
    MoreTab(),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = S.of(context);
    final items = <_TabItem>[
      _TabItem(icon: Icons.home, label: l10n.home),
      _TabItem(icon: Icons.book, label: l10n.tabLibrary),
      const _TabItem(icon: Icons.settings, label: 'Settings'),
    ];
    return Scaffold(body: IndexedStack(children: _tabs));
  }
}

class _TabItem {
  const _TabItem({required this.icon, required this.label});
  final IconData icon;
  final String label;
}
""",
    "mobile/lib/features/home/view/home_tab.dart": """
class HomeTab extends ConsumerWidget {
  const HomeTab({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = S.of(context);
    return Scaffold(
      appBar: AppTopBar(
        title: 'ILM For You',
        actions: [
          AppIconButton(
            icon: Icons.search,
            tooltip: l10n.searchTooltip,
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const LibrarySearchScreen()),
            ),
          ),
          const _SavedAction(),
        ],
      ),
      body: Column(children: [
        SectionHeader(title: 'Featured', onSeeAll: () => context.nav.pushNamed(Routes.bookmarks)),
        Text('Compiled and taught by'),
        Text(l10n.itemsCount(3)),
        const CategoryGrid(),
      ]),
    );
  }
}

class _SavedAction extends StatelessWidget {
  const _SavedAction();
  @override
  Widget build(BuildContext context) => AppIconButton(
        tooltip: 'My Library',
        onTap: () => Navigator.of(context).pushNamed(Routes.bookmarks),
      );
}
""",
    "mobile/lib/features/home/widget/category_grid.dart": """
class CategoryGrid extends StatelessWidget {
  const CategoryGrid({super.key});
  @override
  Widget build(BuildContext context) => CategoryCard(onTap: () => openCategory(context, 'aqeedah'));
}

void openCategory(BuildContext context, String slug) {
  Navigator.pushNamed(context, Routes.libraryCategory, arguments: {'slug': slug});
}
""",
    "mobile/lib/features/library/view/library_tab.dart": """
class LibraryTab extends StatefulWidget {
  const LibraryTab({super.key});
  @override
  State<LibraryTab> createState() => _LibraryTabState();
}

class _LibraryTabState extends State<LibraryTab> {
  @override
  Widget build(BuildContext context) {
    debugPrint('library built');
    return Scaffold(
      appBar: AppBar(title: const Text('Library')),
      body: Column(children: [
        const CategoryGrid(),
        Text('All resources'),
        Image.asset('assets/images/library_header.png'),
      ]),
    );
  }
}
""",
    "mobile/lib/features/library/view/library_category_screen.dart": """
class LibraryCategoryScreen extends ConsumerStatefulWidget {
  const LibraryCategoryScreen({super.key, required this.slug});
  final String slug;
  @override
  ConsumerState<LibraryCategoryScreen> createState() => _LibraryCategoryScreenState();
}

class _LibraryCategoryScreenState extends ConsumerState<LibraryCategoryScreen> {
  Future<void> _confirm() => showDialog(context: context, builder: (_) => AlertDialog(
        title: const Text('Remove download?'),
        content: Text('The file leaves this device.'),
      ));
  @override
  Widget build(BuildContext context) => Text('No resources in ${widget.slug} yet');
}
""",
    "mobile/lib/features/library/view/library_search_screen.dart": """
class LibrarySearchScreen extends StatelessWidget {
  const LibrarySearchScreen({super.key});
  @override
  Widget build(BuildContext context) => Text('Search the library');
}
""",
    "mobile/lib/features/bookmarks/view/bookmarks_screen.dart": """
class BookmarksScreen extends StatelessWidget {
  const BookmarksScreen({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text('Bookmarks')),
        body: Text('No bookmarks yet'),
      );
}
""",
    "mobile/lib/features/more/view/more_tab.dart": """
class MoreTab extends StatelessWidget {
  const MoreTab({super.key});
  @override
  Widget build(BuildContext context) => ListTile(
        title: Text('Bookmarks'),
        onTap: () => Navigator.of(context).pushNamed(Routes.bookmarks),
      );
}
""",
    "mobile/lib/components/section_header.dart": "class SectionHeader extends StatelessWidget {}\n",
    "mobile/lib/models/item.g.dart": "class ItemAdapter extends StatelessWidget {}\nclass GeneratedScreen extends StatelessWidget {}\n",
    "mobile/test/widget_test.dart": "class TestScreen extends StatelessWidget {}\n",
    "mobile/integration_test/app_test.dart": "class FlowScreen extends StatelessWidget {}\n",
    "mobile/ios/Runner/AppDelegate.swift": "import Flutter\n@main\n@objc class AppDelegate: FlutterAppDelegate {}\n",
}


@pytest.fixture
def nav_facts(tmp_path):
    return code.extract(_tree(tmp_path, NAVIGATOR_APP))


def test_navigator_screens_are_keyed_by_class_with_their_route_and_feature(nav_facts):
    screens = _screens(nav_facts)
    assert set(screens) == {
        "splash", "dashboard", "home-tab", "library-tab", "more-tab", "library-category", "library-search", "bookmarks",
    }
    cat = screens["library-category"]
    assert cat.platform == "flutter" and cat.route == "/library/category"
    assert cat.path == "mobile/lib/features/library/view/library_category_screen.dart"
    assert cat.feature_key == "library" and screens["home-tab"].feature_key == "home"
    assert screens["bookmarks"].route == "/bookmarks"
    # Tabs and pushed screens have no named route.
    assert screens["home-tab"].route is None and screens["library-search"].route is None


def test_navigator_edges_follow_named_routes_page_routes_tabs_and_helpers(nav_facts):
    labels = _labels(nav_facts)
    assert labels[("dashboard", "home-tab")] == {"Home tab"}
    assert labels[("dashboard", "library-tab")] == {"Library tab"}
    assert labels[("dashboard", "more-tab")] == {"Settings tab"}
    assert labels[("home-tab", "library-search")] == {"Search"}  # the button's localized tooltip
    assert labels[("home-tab", "bookmarks")] == {"Featured", "My Library"}  # a private widget in the screen's file
    assert labels[("more-tab", "bookmarks")] == {"Bookmarks"}
    assert ("splash", "dashboard") in labels
    # A top-level function in a component file belongs to the screens that render it.
    assert {f for f, t in labels if t == "library-category"} == {"home-tab", "library-tab"}


def test_navigator_texts_read_literals_l10n_titles_and_alerts(nav_facts):
    texts = _texts(nav_facts)
    home = texts["home-tab"]
    assert home.title == "ILM For You"
    assert {"Compiled and taught by", "Search", "* resources"} <= set(home.texts)
    library = texts["library-tab"]
    assert library.title == "Library" and "All resources" in library.texts
    assert "library built" not in library.texts and not any("png" in t for t in library.texts)
    category = texts["library-category"]
    assert "Remove download?" in category.alerts and "No resources in * yet" in category.texts
    assert texts["bookmarks"].title == "Bookmarks"


def test_generated_and_test_dart_is_never_read(nav_facts):
    keys = set(_screens(nav_facts))
    assert not {"generated", "test", "flow"} & keys
    assert all(not rel.endswith(".g.dart") for _, rel in nav_facts.files)


def test_flutter_screens_run_on_both_phones_on_the_map(nav_facts):
    for platform in ("ios", "android"):
        body = payload_from_facts(nav_facts, platform)
        node = next(n for n in body["nodes"] if (n["kind"], n["key"]) == ("screen", "library-category"))
        assert node["detail"]["framework"] == "flutter" and node["detail"]["platform"] == platform
        assert node["detail"]["route"] == "/library/category"
        assert counts(body)["screens"] == 8


def test_feature_map_groups_flutter_screens(tmp_path):
    root = _tree(tmp_path, NAVIGATOR_APP)
    result = fm.scan(root)
    assert "flutter" in result.frameworks
    library = next(f for f in result.features if f.key == "library")
    assert library.summary.startswith("3 screens")


# ---------- GoRouter ----------

GO_ROUTER_APP = {
    "pubspec.yaml": PUBSPEC,
    "assets/translations/en.json": '{"listings": {"title": "Your listings"}, "empty": "Nothing listed yet"}',
    "lib/router.dart": """
final router = GoRouter(
  routes: [
    ShellRoute(
      builder: (context, state, child) => AppShell(child: child),
      routes: [
        GoRoute(
          path: '/listings',
          name: 'listings',
          builder: (context, state) => const ListingsPage(),
          routes: [
            GoRoute(path: ':id', name: 'listing', builder: (context, state) => ListingDetailPage(id: state.pathParameters['id']!)),
          ],
        ),
        GoRoute(path: '/settings', pageBuilder: (context, state) => NoTransitionPage(child: SettingsView())),
      ],
    ),
  ],
);
""",
    "lib/shell.dart": "class AppShell extends StatelessWidget {}\n",
    "lib/listings/listings_page.dart": """
class ListingsPage extends StatelessWidget {
  const ListingsPage({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text('listings.title'.tr())),
        body: ListTile(title: Text('Open listing'), onTap: () => context.go('/listings/${item.id}')),
        floatingActionButton: FloatingActionButton(tooltip: 'Settings', onPressed: () => context.goNamed('settings-missing')),
      );
}
""",
    "lib/listings/listing_detail_page.dart": """
class ListingDetailPage extends StatelessWidget {
  const ListingDetailPage({super.key, required this.id});
  final String id;
  @override
  Widget build(BuildContext context) => TextButton(onPressed: () => context.pushNamed('listings'), child: Text('Back to listings'));
}
""",
    "lib/settings/settings_view.dart": """
class SettingsView extends StatelessWidget {
  @override
  Widget build(BuildContext context) => Text('empty'.tr());
}
""",
}


def test_go_router_paths_nest_and_go_and_named_pushes_resolve(tmp_path):
    facts = code.extract(_tree(tmp_path, GO_ROUTER_APP))
    screens = _screens(facts)
    assert screens["listings"].route == "/listings"
    assert screens["listing-detail"].route == "/listings/:id"
    assert screens["settings"].route == "/settings"
    assert "app-shell" not in screens  # a shell wraps screens, it is none
    labels = _labels(facts)
    assert labels[("listings", "listing-detail")] == {"Open listing"}
    assert labels[("listing-detail", "listings")] == {"Back to listings"}
    texts = _texts(facts)
    assert texts["listings"].title == "Your listings"
    assert "Nothing listed yet" in texts["settings"].texts


# ---------- auto_route and GetX ----------

AUTO_ROUTE_APP = {
    "pubspec.yaml": PUBSPEC,
    "lib/app_router.dart": """
@AutoRouterConfig()
class AppRouter extends RootStackRouter {
  @override
  List<AutoRoute> get routes => [
        AutoRoute(page: CartRoute.page, path: '/cart'),
        AutoRoute(page: CheckoutRoute.page, path: '/checkout'),
      ];
}
""",
    "lib/cart/cart_screen.dart": """
@RoutePage()
class CartScreen extends StatelessWidget {
  @override
  Widget build(BuildContext context) => ElevatedButton(
        onPressed: () => context.router.push(const CheckoutRoute()),
        child: const Text('Checkout'),
      );
}
""",
    "lib/checkout/checkout_screen.dart": """
@RoutePage()
class CheckoutScreen extends StatelessWidget {
  @override
  Widget build(BuildContext context) => TextButton(onPressed: () => Get.to(() => ReceiptView()), child: Text('Pay now'));
}
""",
    "lib/checkout/receipt.dart": "class ReceiptView extends GetView<ReceiptController> {}\n",
}


def test_auto_route_and_getx_screens_and_pushes(tmp_path):
    facts = code.extract(_tree(tmp_path, AUTO_ROUTE_APP))
    screens = _screens(facts)
    assert screens["cart"].route == "/cart" and screens["checkout"].route == "/checkout"
    assert "receipt" in screens  # `Get.to(() => ReceiptView())` opens it
    labels = _labels(facts)
    assert labels[("cart", "checkout")] == {"Checkout"}
    assert labels[("checkout", "receipt")] == {"Pay now"}


def test_ui_text_keeps_flutter_words():
    assert ui_text("Remove download?") == "Remove download?"
    assert ui_text("assets/images/x.png") is None
