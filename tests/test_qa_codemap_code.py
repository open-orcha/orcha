"""The QA map's code readers (`orcha_cli.qa.codemap.code`, ported from the original's
`tests/unit/app_map/test_app_map_code.py` and the key tests of `test_app_map.py`): keys, the
string and route helpers, and `extract` on small fixture repos per platform (SwiftUI with
SwiftData, Core Data and URLSession; Next.js with Prisma; React Navigation with axios; Expo
Router with Supabase; Android Compose with Retrofit and Room), plus the JS server frameworks
(the original Spring and Ktor server cases are not ported with their readers)."""

from __future__ import annotations

from pathlib import Path

import pytest

from orcha_cli.qa.codemap import features as fm
from orcha_cli.qa.codemap import code, keys
from orcha_cli.qa.codemap.payload import payload_from_facts
from orcha_cli.qa.codemap.code import collapse_route, endpoint_key, entity_key, screen_key, string_arg


def _tree(root: Path, files: dict[str, str]) -> Path:
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    return root


def _screens(facts: code.CodeFacts) -> dict[str, code.CodeScreen]:
    return {s.key: s for s in facts.screens}


def _edges(facts: code.CodeFacts) -> set[tuple[str, str]]:
    return {(n.from_key, n.to_key) for n in facts.navigation}


def _labels(facts: code.CodeFacts) -> dict[tuple[str, str], set[str]]:
    out: dict[tuple[str, str], set[str]] = {}
    for n in facts.navigation:
        out.setdefault((n.from_key, n.to_key), set()).add(n.label)
    return out


def _endpoints(facts: code.CodeFacts, side: str | None = None) -> set[str]:
    return {endpoint_key(e.method, e.pattern) for e in facts.endpoints if side is None or e.side == side}


def _access(facts: code.CodeFacts) -> set[tuple[str, str, str]]:
    return {(a.source, a.entity_key, a.mode) for a in facts.access}


# ---------- keys ----------


@pytest.mark.parametrize(
    ("raw", "pattern"),
    [
        ("/api/listings/[id]", "/api/listings/*"),
        ("https://api.example.com/api/listings/812?a=1#x", "/api/listings/*"),
        ("/users/:id/posts/{postId}", "/users/*/posts/*"),
        ("/listings/${id}/edit", "/listings/*/edit"),
        ("/listings/\\(listing.id)", "/listings/*"),
        ("/(marketing)/@modal/about", "/about"),
        ("/docs/[...slug]", "/docs/*"),
        ("/orders/0b6c1b9e-4f0c-4e1e-9d47-1c2b3a4d5e6f", "/orders/*"),
        ("/api/issues/insights\x00", "/api/issues/insights"),
        ("/items/item-\x00", "/items/*"),
        ("", "/"),
        ("/listings/", "/listings"),
    ],
)
def test_collapse_route_matches_the_traffic_rule(raw, pattern):
    assert collapse_route(raw) == pattern


def test_endpoint_key_upper_cases_and_collapses():
    assert endpoint_key("get", "/api/listings/[id]") == "GET /api/listings/*"
    assert endpoint_key("", "/x") == "* /x"


@pytest.mark.parametrize(
    ("name", "key"),
    [
        ("ListingDetailView", "listing-detail"),
        ("SettingsViewController", "settings"),
        ("SettingsScreen", "settings"),
        ("ListingDetail", "listing-detail"),
        ("ProfileActivity", "profile"),
        ("Home", "home"),
    ],
)
def test_screen_key_drops_the_screen_kind(name, key):
    assert screen_key(name) == key


@pytest.mark.parametrize(
    ("name", "key"),
    [
        ("Listing", "listing"),
        ("listings", "listing"),
        ("listing_table", "listing"),
        ("ListingEntity", "listing"),
        ("ListingPhoto", "listing_photo"),
        ("categories", "category"),
        ("container_sizes", "container_size"),
        ("addresses", "address"),
        ("status", "status"),
        ("user_settings", "user_setting"),
    ],
)
def test_entity_key_is_singular_lower_case(name, key):
    assert entity_key(name) == key


@pytest.mark.parametrize(
    ("src", "lang", "path"),
    [
        ('"/api/listings"', "js", "/api/listings"),
        ("`/listings/${id}`", "js", "/listings/\x00"),
        ("`${API_URL}/listings`", "js", "/listings"),
        ('"/listings/" + listing.id + "/edit"', "js", "/listings/\x00/edit"),
        ("BASE + 'listings'", "js", "/listings"),
        ("`/api/x${q ? `?q=${q}` : ''}`", "js", "/api/x"),
        ("someVariable", "js", None),
        ('"\\(baseURL)/listings/\\(id)"', "swift", "/listings/\x00"),
        ('"listing/$id"', "kotlin", "listing/\x00"),
        ('"listing/${item.id}"', "kotlin", "listing/\x00"),
    ],
)
def test_string_arg_spells_the_path(src, lang, path):
    assert string_arg(src, 0, lang) == path


def test_string_arg_resolves_constants():
    consts = {"GET_LISTINGS": "get_listings"}
    assert string_arg("apiEndpoints.GET_LISTINGS, params", 0, "js", consts) == "get_listings"
    assert string_arg("`${apiEndpoints.GET_LISTINGS}/${id}`", 0, "js", consts) == "get_listings/\x00"


def test_route_name_is_human():
    assert code.route_name("/") == "Home"
    assert code.route_name("/listings/*") == "Listings detail"
    assert code.route_name("/listing_detail/*") == "Listing detail"
    assert code.route_name("/settings/profile") == "Settings profile"


def test_close_of_skips_strings_and_comments():
    text = 'f(a, ")", { b: "(" } // )\n, c)'
    assert code.close_of(text, 1) == len(text) - 1


# ---------- SwiftUI, UIKit, SwiftData, Core Data, URLSession ----------

SWIFT_APP = {
    "Listings/ListingsApp.swift": "import SwiftUI\n@main\nstruct ListingsApp: App {\n    var body: some Scene { WindowGroup { ListingsView() } }\n}\n",
    "Listings/Info.plist": "<plist/>",
    "Listings/Features/Listings/ListingsView.swift": """import SwiftUI
import SwiftData

struct ListingsView: View {
    @Query(sort: \\Listing.createdAt) private var listings: [Listing]
    @Environment(\\.modelContext) private var modelContext
    @State private var showNew = false

    var body: some View {
        NavigationStack {
            List(listings) { listing in
                NavigationLink(destination: ListingDetailView(listing: listing)) {
                    Text("Open listing")
                }
                ListingRow(listing: listing)
            }
            .toolbar { Button("Add") { showNew = true } }
            .sheet(isPresented: $showNew) {
                NewListingView()
            }
            .navigationDestination(for: Listing.self) { item in
                ListingDetailView(listing: item)
            }
        }
    }

    private func remove(_ listing: Listing) {
        modelContext.delete(listing)
    }
}
""",
    "Listings/Features/Listings/ListingDetailView.swift": """import SwiftUI

struct ListingDetailView: View {
    let listing: Listing
    var body: some View {
        NavigationLink("Book a viewing") {
            BookingView()
        }
    }
}
""",
    "Listings/Features/Listings/NewListingView.swift": """import SwiftUI

struct NewListingView: View {
    @Environment(\\.modelContext) private var modelContext
    var body: some View { Button("Save") { save() } }
    private func save() {
        modelContext.insert(Listing(title: "Flat in Westlands", price: 1200))
    }
}
""",
    "Listings/Features/Listings/ListingRow.swift": """import SwiftUI

struct ListingRow: View {
    let listing: Listing
    var body: some View {
        NavigationLink {
            BookingView()
        } label: {
            Text("Book now")
        }
    }
}
""",
    "Listings/Features/Booking/BookingView.swift": "import SwiftUI\nstruct BookingView: View {\n    var body: some View { Text(\"Booking\") }\n}\n",
    "Listings/Features/Settings/SettingsViewController.swift": """import UIKit

final class SettingsViewController: UIViewController {
    @objc private func openAbout() {
        let about = AboutViewController()
        navigationController?.pushViewController(about, animated: true)
    }
}
""",
    "Listings/Features/Settings/AboutViewController.swift": "import UIKit\nfinal class AboutViewController: UIViewController {}\n",
    "Listings/Models/Listing.swift": """import SwiftData

@Model
final class Listing {
    var title: String
    var price: Int
    var createdAt: Date = Date.now
    var isCheap: Bool { price < 500 }
    static let sample = 1

    init(title: String, price: Int) {
        self.title = title
        self.price = price
    }
}
""",
    "Listings/Networking/APIClient.swift": """import Foundation

final class APIClient {
    let baseURL = URL(string: "https://api.example.com/v1")!

    func listings() async throws -> Data {
        let request = URLRequest(url: baseURL.appendingPathComponent("listings"))
        return try await URLSession.shared.data(for: request).0
    }

    func book(id: Int) async throws {
        var request = URLRequest(url: URL(string: "https://api.example.com/v1/listings/\\(id)/bookings")!)
        request.httpMethod = "POST"
        _ = try await URLSession.shared.data(for: request)
    }

    func photosFolder() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("Photos")
    }
}
""",
    "Listings/Model.xcdatamodeld/Model.xcdatamodel/contents": """<?xml version="1.0" encoding="UTF-8"?>
<model type="com.apple.IDECoreDataModeler.DataModel">
    <entity name="Agent" representedClassName="Agent" syncable="YES">
        <attribute name="name" optional="YES" attributeType="String"/>
        <attribute name="phone" optional="YES" attributeType="String"/>
        <relationship name="listings" toMany="YES" destinationEntity="Listing"/>
    </entity>
</model>
""",
}


@pytest.fixture
def swift_facts(tmp_path):
    return code.extract(_tree(tmp_path, SWIFT_APP))


def test_swift_screens_are_keyed_by_name_with_their_feature(swift_facts, tmp_path):
    screens = _screens(swift_facts)
    assert set(screens) == {"listings", "listing-detail", "new-listing", "booking", "settings", "about"}
    detail = screens["listing-detail"]
    assert (detail.platform, detail.route, detail.name) == ("swiftui", None, "Listing detail")
    assert (detail.path, detail.line) == ("Listings/Features/Listings/ListingDetailView.swift", 3)
    assert screens["about"].platform == "uikit"
    # The keys `app_features` has, so the map can place every screen in its feature.
    features = {f.key for f in fm.scan(tmp_path).features}
    assert {s.feature_key for s in swift_facts.screens} <= features
    assert screens["listing-detail"].feature_key == "listings"


def test_swift_navigation_links_sheets_destinations_and_pushes(swift_facts):
    edges = _edges(swift_facts)
    assert ("listings", "listing-detail") in edges  # NavigationLink(destination:) and .navigationDestination
    assert ("listings", "new-listing") in edges  # .sheet
    assert ("listing-detail", "booking") in edges  # NavigationLink("...") { BookingView() }
    assert ("listings", "booking") in edges  # through ListingRow, a component ListingsView renders
    assert ("settings", "about") in edges  # pushViewController of a variable
    labels = _labels(swift_facts)
    assert "Open listing" in labels[("listings", "listing-detail")]
    assert labels[("listing-detail", "booking")] == {"Book a viewing"}
    assert labels[("listings", "booking")] == {"Book now"}
    assert labels[("listings", "new-listing")] == {"Open New listing"}
    link = next(n for n in swift_facts.navigation if n.label == "Book a viewing")
    assert (link.path, link.line) == ("Listings/Features/Listings/ListingDetailView.swift", 6)


def test_swift_endpoints_strip_the_base_and_keep_the_method(swift_facts):
    assert _endpoints(swift_facts) == {"GET /listings", "POST /v1/listings/*/bookings"}
    assert all(e.side == "client" for e in swift_facts.endpoints)


def test_swiftdata_and_core_data_entities(swift_facts):
    entities = {e.key: e for e in swift_facts.entities}
    assert entities["listing"].store == "swiftdata"
    assert entities["listing"].fields == ("title", "price", "createdAt")  # not the computed isCheap
    assert entities["agent"].store == "coredata"
    assert entities["agent"].fields == ("name", "phone", "listings")


def test_swiftdata_reads_and_writes_by_screen(swift_facts):
    assert _access(swift_facts) == {
        ("listings", "listing", "reads"),
        ("listings", "listing", "writes"),
        ("new-listing", "listing", "writes"),
    }


# ---------- Next.js with Prisma ----------

NEXT_APP = {
    "package.json": '{"name": "listings-web", "dependencies": {"next": "14.2.0", "@prisma/client": "5.0.0"}}',
    "app/page.tsx": 'import Link from "next/link";\nexport default function Home() {\n  return <Link href="/listings">Browse listings</Link>;\n}\n',
    "app/listings/page.tsx": """"use client";
import { useRouter } from "next/navigation";
import { ListingCard } from "@/components/ListingCard";

export default function ListingsPage({ listings }) {
  const router = useRouter();
  const load = () => fetch("/api/listings");
  return (
    <div>
      {listings.map((l) => <ListingCard key={l.id} listing={l} />)}
      <button onClick={() => router.push(`/listings/${listings[0].id}`)}>Open first</button>
    </div>
  );
}
""",
    "app/listings/[id]/page.tsx": """import { redirect } from "next/navigation";

export default async function ListingPage({ params }) {
  const res = await fetch(`${process.env.API_URL}/api/listings/${params.id}`, { cache: "no-store" });
  if (res.status === 401) redirect("/login");
  return <main>{params.id}</main>;
}
""",
    "app/listings/new/page.tsx": """export default function NewListing() {
  async function save(body) {
    await fetch("/api/listings", { method: "POST", body: JSON.stringify(body) });
  }
  return <form action={save} />;
}
""",
    "app/(auth)/login/page.tsx": "export default function Login() { return <form /> }\n",
    "components/ListingCard.tsx": """import Link from "next/link";

export function ListingCard({ listing }) {
  return (
    <div>
      <Link href={`/listings/${listing.id}`}>{listing.title}</Link>
      <Link href="/listings/new">New listing</Link>
    </div>
  );
}
""",
    "components/Footer.tsx": 'import Link from "next/link";\nexport function Footer() { return <Link href="/login">Sign in</Link> }\n',
    "app/api/listings/route.ts": """import { prisma } from "@/lib/prisma";

export async function GET() {
  const listings = await prisma.listing.findMany({ orderBy: { createdAt: "desc" } });
  return Response.json(listings);
}

export async function POST(req: Request) {
  const data = await req.json();
  const created = await prisma.listing.create({ data });
  return Response.json(created, { status: 201 });
}
""",
    "app/api/listings/[id]/route.ts": """import { prisma } from "@/lib/prisma";
import { removeListing } from "@/lib/listings";

export async function GET(_req: Request, { params }) {
  return Response.json(await prisma.listing.findUnique({ where: { id: params.id } }));
}

export async function DELETE(_req: Request, { params }) {
  await removeListing(params.id);
  return new Response(null, { status: 204 });
}
""",
    "lib/listings.ts": """import { prisma } from "./prisma";

export async function removeListing(id: string) {
  await prisma.booking.deleteMany({ where: { listingId: id } });
  await prisma.listing.delete({ where: { id } });
}

export async function countListings() {
  return prisma.listing.count();
}
""",
    "lib/prisma.ts": 'import { PrismaClient } from "@prisma/client";\nexport const prisma = new PrismaClient();\n',
    "prisma/schema.prisma": """generator client {
  provider = "prisma-client-js"
}

model Listing {
  id        String    @id @default(cuid())
  title     String
  price     Int
  status    Status    @default(DRAFT)
  bookings  Booking[]
  createdAt DateTime  @default(now())

  @@map("listings")
}

model Booking {
  id        Int     @id @default(autoincrement())
  listing   Listing @relation(fields: [listingId], references: [id])
  listingId String
}

enum Status {
  DRAFT
  LIVE
}
""",
}


@pytest.fixture
def next_facts(tmp_path):
    return code.extract(_tree(tmp_path, NEXT_APP))


def test_next_screens_are_route_patterns(next_facts, tmp_path):
    screens = _screens(next_facts)
    assert set(screens) == {"/", "/listings", "/listings/*", "/listings/new", "/login"}
    assert screens["/listings/*"].route == "/listings/*"
    assert screens["/listings/*"].path == "app/listings/[id]/page.tsx"
    assert screens["/listings/*"].platform == "next"
    features = {f.key for f in fm.scan(tmp_path).features}
    assert {s.feature_key for s in next_facts.screens} <= features


def test_next_navigation_links_pushes_and_redirects(next_facts):
    edges = _edges(next_facts)
    assert ("/", "/listings") in edges
    assert ("/listings", "/listings/*") in edges  # router.push with a template, and the card's link
    assert ("/listings", "/listings/new") in edges  # the card's static link: `/new` over `/*`
    assert ("/listings/*", "/login") in edges  # redirect()
    labels = _labels(next_facts)
    assert labels[("/", "/listings")] == {"Browse listings"}
    assert labels[("/listings", "/listings/new")] == {"New listing"}
    assert "Open first" in labels[("/listings", "/listings/*")]
    # The footer is chrome: its links lead from every page, so from no one page.
    assert not [n for n in next_facts.navigation if n.path == "components/Footer.tsx"]


def test_next_client_and_server_endpoints(next_facts):
    assert _endpoints(next_facts, "client") == {"GET /api/listings", "GET /api/listings/*", "POST /api/listings"}
    assert _endpoints(next_facts, "server") == {"GET /api/listings", "POST /api/listings", "GET /api/listings/*", "DELETE /api/listings/*"}
    server = {(e.method, e.pattern): e for e in next_facts.endpoints if e.side == "server"}
    assert server[("DELETE", "/api/listings/*")].handler == "DELETE"
    assert server[("DELETE", "/api/listings/*")].path == "app/api/listings/[id]/route.ts"


def test_prisma_entities_keep_scalar_and_enum_fields(next_facts):
    entities = {e.key: e for e in next_facts.entities}
    assert entities["listing"].store == "prisma"
    assert entities["listing"].fields == ("id", "title", "price", "status", "createdAt")
    assert entities["booking"].fields == ("id", "listingId")
    assert entities["listing"].path == "prisma/schema.prisma"


def test_prisma_access_follows_each_handler_into_imported_helpers(next_facts):
    assert _access(next_facts) == {
        ("GET /api/listings", "listing", "reads"),
        ("POST /api/listings", "listing", "writes"),
        ("GET /api/listings/*", "listing", "reads"),
        ("DELETE /api/listings/*", "booking", "writes"),
        ("DELETE /api/listings/*", "listing", "writes"),
    }
    helper = next(a for a in next_facts.access if a.entity_key == "booking")
    assert (helper.path, helper.line) == ("lib/listings.ts", 4)


# ---------- React Navigation with axios ----------

RN_APP = {
    "package.json": '{"name": "listings-mobile", "dependencies": {"expo": "51.0.0", "@react-navigation/native": "6.1.0", "axios": "1.7.0"}}',
    "App.tsx": """import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import HomeScreen from "./src/screens/HomeScreen";
import ListingDetailScreen from "./src/screens/ListingDetailScreen";
import SettingsScreen from "./src/screens/SettingsScreen";

const Stack = createNativeStackNavigator();

export default function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator>
        <Stack.Screen name="Home" component={HomeScreen} />
        <Stack.Screen name="ListingDetail" component={ListingDetailScreen} />
        <Stack.Screen name="Settings" component={SettingsScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
""",
    "src/api/client.ts": 'import axios from "axios";\nexport const api = axios.create({ baseURL: "https://api.example.com/v1" });\n',
    "src/api/endpoints.ts": 'export const ENDPOINTS = {\n  FAVORITES: "/me/favorites",\n};\n',
    "src/screens/HomeScreen.tsx": """import { Button } from "react-native";
import { api } from "../api/client";

export default function HomeScreen({ navigation }) {
  const load = () => api.get("/listings", { params: { page: 1 } });
  const favorites = () => api.get(ENDPOINTS.FAVORITES);
  return <Button title="See listing" onPress={() => navigation.navigate("ListingDetail", { id: 1 })} />;
}
""",
    "src/screens/ListingDetailScreen.tsx": """import { api } from "../api/client";

export default function ListingDetailScreen({ navigation, route }) {
  const favorite = () => api.post(`/listings/${route.params.id}/favorite`);
  const params = new URLSearchParams();
  params.get("page");
  return <Pressable onPress={() => navigation.navigate("Settings")}><Text>Settings</Text></Pressable>;
}
""",
    "src/screens/SettingsScreen.tsx": "export default function SettingsScreen() { return null }\n",
}


def test_react_navigation_screens_edges_and_axios(tmp_path):
    facts = code.extract(_tree(tmp_path, RN_APP))
    screens = _screens(facts)
    assert set(screens) == {"home", "listing-detail", "settings"}
    assert screens["home"].platform == "react-navigation"
    assert screens["home"].path == "App.tsx" and screens["home"].line == 13
    labels = _labels(facts)
    assert labels[("home", "listing-detail")] == {"See listing"}
    assert labels[("listing-detail", "settings")] == {"Settings"}
    assert _endpoints(facts) == {"GET /listings", "GET /me/favorites", "POST /listings/*/favorite"}


# ---------- Expo Router with Supabase ----------

EXPO_APP = {
    "package.json": '{"name": "fleet", "dependencies": {"expo-router": "3.5.0", "@supabase/supabase-js": "2.0.0"}}',
    "app/_layout.tsx": 'import { Stack } from "expo-router";\nexport default function Layout() { return <Stack /> }\n',
    "app/index.tsx": """import { router } from "expo-router";
export default function Index() {
  return <Pressable onPress={() => router.push("/trips")}><Text>See trips</Text></Pressable>;
}
""",
    "app/(tabs)/trips.tsx": """import { supabase } from "../../lib/supabase";
import { router } from "expo-router";

export default function Trips() {
  const load = async () => {
    const { data } = await supabase.from("trips").select("*").order("date");
    await supabase.storage.from("receipts").upload("a.png", file);
    await supabase.rpc("close_month", { month: 1 });
  };
  return <Pressable onPress={() => router.push({ pathname: "/trip/[id]", params: { id } })} />;
}
""",
    "app/trip/[id].tsx": """import { supabase } from "../../lib/supabase";
export default function Trip() {
  const remove = () => supabase
    .from("trips")
    .delete()
    .eq("id", id);
  return null;
}
""",
    "lib/supabase.ts": 'import { createClient } from "@supabase/supabase-js";\nexport const supabase = createClient(url, key);\n',
    "supabase/migrations/0001_init.sql": """-- trips a driver records
create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references profiles(id),
  amount numeric(12, 2) not null,
  constraint trips_amount_positive check (amount > 0)
);
""",
    "supabase/migrations/0002_notes.sql": "alter table trips add column notes text;\n",
}


def test_expo_router_with_supabase_tables(tmp_path):
    facts = code.extract(_tree(tmp_path, EXPO_APP))
    assert set(_screens(facts)) == {"/", "/trips", "/trip/*"}
    assert _screens(facts)["/trips"].platform == "expo"
    assert _edges(facts) == {("/", "/trips"), ("/trips", "/trip/*")}
    assert _labels(facts)[("/", "/trips")] == {"See trips"}
    assert _endpoints(facts) == {"GET /rest/v1/trips", "DELETE /rest/v1/trips", "POST /rest/v1/rpc/close_month"}
    trips = next(e for e in facts.entities if e.key == "trip")
    assert (trips.store, trips.name) == ("api", "trips")
    assert trips.fields == ("id", "driver_id", "amount", "notes")  # from the migrations
    assert not [e for e in facts.entities if e.key == "receipt"]  # a storage bucket is not a table
    assert _access(facts) == {("GET /rest/v1/trips", "trip", "reads"), ("DELETE /rest/v1/trips", "trip", "writes")}


# ---------- Android: Compose, activities, Retrofit, Ktor, Room ----------

PKG = "app/src/main/java/com/acme/listings"  # not `com/example`: feature_map never walks an `example` folder
ANDROID_APP = {
    "app/src/main/AndroidManifest.xml": """<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.acme.listings">
    <application>
        <activity android:name=".MainActivity" />
        <activity android:name=".SettingsActivity" />
    </application>
</manifest>
""",
    f"{PKG}/MainActivity.kt": "package com.acme.listings\nclass MainActivity : ComponentActivity()\n",
    f"{PKG}/SettingsActivity.kt": "package com.acme.listings\n\nclass SettingsActivity : ComponentActivity()\n",
    f"{PKG}/nav/Routes.kt": """package com.acme.listings.nav

sealed class Screen(val route: String) {
    data object Listings : Screen("listings")
    data object Detail : Screen("listing/{id}") {
        fun createRoute(id: Long) = "listing/$id"
    }
}
""",
    f"{PKG}/nav/AppNavHost.kt": """package com.acme.listings.nav

@Composable
fun AppNavHost(navController: NavHostController) {
    NavHost(navController, startDestination = Screen.Listings.route) {
        composable(Screen.Listings.route) {
            ListingsScreen(onOpen = { id -> navController.navigate(Screen.Detail.createRoute(id)) })
        }
        composable(route = Screen.Detail.route) { entry ->
            ListingDetailScreen(onAbout = { navController.navigate("about") })
        }
        composable("about") {
            AboutScreen()
        }
    }
}
""",
    f"{PKG}/ui/ListingsScreen.kt": """package com.acme.listings.ui

@Composable
fun ListingsScreen(onOpen: (Long) -> Unit, viewModel: ListingsViewModel = hiltViewModel()) {
    val context = LocalContext.current
    Button(onClick = { context.startActivity(Intent(context, SettingsActivity::class.java)) }) {
        Text("Settings")
    }
}
""",
    f"{PKG}/ui/ListingDetailScreen.kt": "package com.acme.listings.ui\n\n@Composable\nfun ListingDetailScreen(onAbout: () -> Unit) {}\n",
    f"{PKG}/ui/AboutScreen.kt": "package com.acme.listings.ui\n\n@Composable\nfun AboutScreen() {}\n",
    f"{PKG}/ui/ListingsViewModel.kt": """package com.acme.listings.ui

@HiltViewModel
class ListingsViewModel @Inject constructor(
    private val repository: ListingRepository,
) : ViewModel()
""",
    f"{PKG}/data/ListingRepository.kt": "package com.acme.listings.data\n\ninterface ListingRepository {\n    suspend fun all(): List<ListingEntity>\n}\n",
    f"{PKG}/data/ListingRepositoryImpl.kt": """package com.acme.listings.data

class ListingRepositoryImpl @Inject constructor(
    private val dao: ListingDao,
    private val api: ListingApi,
) : ListingRepository {
    override suspend fun all() = dao.getAll()
    suspend fun refresh() = dao.insertAll(api.listings())
}
""",
    f"{PKG}/data/ListingDao.kt": """package com.acme.listings.data

@Dao
interface ListingDao {
    @Query("SELECT * FROM listings ORDER BY id")
    suspend fun getAll(): List<ListingEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(items: List<ListingEntity>)

    @Query("DELETE FROM listings")
    suspend fun clear()
}
""",
    f"{PKG}/data/ListingEntity.kt": """package com.acme.listings.data

@Entity(tableName = "listings", indices = [Index(value = ["title"])])
data class ListingEntity(
    @PrimaryKey val id: Long,
    @ColumnInfo(name = "title") val title: String,
    val price: Int = 0,
)
""",
    f"{PKG}/data/ListingApi.kt": """package com.acme.listings.data

interface ListingApi {
    @GET("listings")
    suspend fun listings(): List<ListingEntity>

    @POST("listings/{id}/favorite")
    suspend fun favorite(@Path("id") id: Long)
}
""",
    f"{PKG}/data/AgentsClient.kt": """package com.acme.listings.data

class AgentsClient(private val client: HttpClient) {
    suspend fun agents() = client.get("https://api.example.com/v1/agents")
}
""",
}


@pytest.fixture
def android_facts(tmp_path):
    return code.extract(_tree(tmp_path, ANDROID_APP))


def test_android_screens_from_compose_routes_constants_and_activities(android_facts):
    screens = _screens(android_facts)
    assert set(screens) == {"/listings", "/listing/*", "/about", "settings"}
    assert screens["/listings"].platform == "compose"  # `composable(Screen.Listings.route)`
    assert (screens["/listings"].path, screens["/listings"].line) == (f"{PKG}/nav/AppNavHost.kt", 6)
    assert screens["settings"].platform == "android"
    assert (screens["settings"].path, screens["settings"].line) == (f"{PKG}/SettingsActivity.kt", 3)


def test_android_navigation_from_nav_graph_blocks_and_intents(android_facts):
    assert _edges(android_facts) == {("/listings", "/listing/*"), ("/listing/*", "/about"), ("/listings", "settings")}
    assert _labels(android_facts)[("/listings", "settings")] == {"Settings"}


def test_android_retrofit_and_ktor_endpoints(android_facts):
    assert _endpoints(android_facts) == {"GET /listings", "POST /listings/*/favorite", "GET /v1/agents"}
    retrofit = next(e for e in android_facts.endpoints if e.method == "POST")
    assert retrofit.handler == "favorite"


def test_room_entities_and_dao_access_through_view_model_and_repository(android_facts):
    entity = next(e for e in android_facts.entities if e.key == "listing")
    assert (entity.store, entity.name, entity.fields) == ("room", "ListingEntity", ("id", "title", "price"))
    # ListingsScreen -> ListingsViewModel -> ListingRepository (its Impl) -> ListingDao.
    assert _access(android_facts) == {("/listings", "listing", "reads"), ("/listings", "listing", "writes")}


# ---------- server frameworks ----------


def test_express_routes_with_mounted_prefixes_and_controller_access(tmp_path):
    _tree(tmp_path, {
        "server/package.json": '{"dependencies": {"express": "4.19.0"}}',
        "server/src/index.ts": """import express from "express";
import listings from "./routes/listings";

const app = express();
app.use("/api/listings", listings);
app.get("/health", (_req, res) => res.send("ok"));
app.listen(3000);
""",
        "server/src/routes/listings.ts": """import { Router } from "express";
import * as controller from "../controllers/listings";

const router = Router();
router.get("/", controller.list);
router.post("/:id/book", async (req, res) => {
  await db.booking.create({ data: req.body });
  res.status(201).end();
});
router.route("/:id").get(controller.show).delete(controller.remove);
export default router;
""",
        "server/src/controllers/listings.ts": """import { prisma } from "../db";

export async function list(req, res) {
  res.json(await prisma.listing.findMany());
}

export async function show(req, res) {
  res.json(await prisma.listing.findUnique({ where: { id: req.params.id } }));
}

export async function remove(req, res) {
  await prisma.listing.delete({ where: { id: req.params.id } });
}
""",
    })
    facts = code.extract(tmp_path)
    assert _endpoints(facts, "server") == {
        "GET /health", "GET /api/listings", "POST /api/listings/*/book", "GET /api/listings/*", "DELETE /api/listings/*",
    }
    assert ("GET /api/listings", "listing", "reads") in _access(facts)
    assert ("GET /api/listings/*", "listing", "reads") in _access(facts)
    assert ("DELETE /api/listings/*", "listing", "writes") in _access(facts)
    assert ("POST /api/listings/*/book", "booking", "writes") in _access(facts)
    assert ("GET /api/listings", "listing", "writes") not in _access(facts)
    assert not _endpoints(facts, "client")  # `app.get` / `router.get` are routes, not calls
    list_route = next(e for e in facts.endpoints if e.pattern == "/api/listings")
    assert list_route.handler == "controller.list"


def test_pages_api_and_nest_server_routes(tmp_path):
    _tree(tmp_path, {
        "web/package.json": '{"dependencies": {"next": "13.0.0"}}',
        "web/pages/api/listings/[id].ts": """export default function handler(req, res) {
  if (req.method === "DELETE") return res.status(204).end();
  if (req.method === "GET") return res.json({});
}
""",
        "nest/src/main.ts": 'const app = await NestFactory.create(AppModule);\napp.setGlobalPrefix("api");\n',
        "nest/src/listings.controller.ts": """import { Controller, Get, Post } from "@nestjs/common";

@Controller("listings")
export class ListingsController {
  @Get(":id")
  findOne(@Param("id") id: string) {}

  @Post()
  async create(@Body() dto: CreateListingDto) {}
}
""",
    })
    facts = code.extract(tmp_path)
    assert _endpoints(facts, "server") == {
        "DELETE /api/listings/*", "GET /api/listings/*",  # pages/api, and Nest under its global prefix
        "POST /api/listings",
    }
    nest = next(e for e in facts.endpoints if e.pattern == "/api/listings" and e.method == "POST")
    assert nest.handler == "create"


def test_swift_typed_endpoints_and_switch_routers(tmp_path):
    _tree(tmp_path, {
        "App/Networking/Endpoint.swift": """struct Endpoint {
    let path: String
    let method: HTTPMethod
    init(path: String, method: HTTPMethod = .get, query: [String: String] = [:]) {
        self.path = path
        self.method = method
    }
}

extension Endpoint {
    static func property(id: Int) -> Endpoint { Endpoint(path: "get_property", query: ["id": String(id)]) }
    static func book(id: Int) -> Endpoint { Endpoint(path: "properties/\\(id)/book", method: .post) }
}
""",
        "App/Networking/Router.swift": """import Foundation

enum Router {
    case agents
    case agent(id: Int)
    case login

    var path: String {
        switch self {
        case .agents: return "/agents"
        case .agent(let id): return "/agents/\\(id)"
        case .login: return "/auth/login"
        }
    }

    var method: String {
        switch self {
        case .login: return "POST"
        default: return "GET"
        }
    }

    func request(base: URL) -> URLRequest { URLRequest(url: base) }
}
""",
    })
    facts = code.extract(tmp_path)
    assert _endpoints(facts) == {
        "GET /get_property", "POST /properties/*/book",
        "GET /agents", "GET /agents/*", "POST /auth/login",
    }


def test_screen_attribution_rules(tmp_path):
    _tree(tmp_path, {
        "package.json": '{"dependencies": {"next": "14.0.0"}}',
        "apps/web/package.json": '{"dependencies": {"next": "14.0.0"}}',
        "apps/web/app/trips/page.tsx": 'import { TripList } from "./trip-list";\nexport default function Page() { return <TripList /> }\n',
        "apps/web/app/trips/trip-list.tsx": 'export function TripList() { return <Link href="/settings">Settings</Link> }\n',
        "apps/web/app/settings/page.tsx": "export default function Settings() { return null }\n",
        "apps/web/app/settings/helpers.ts": 'export const go = () => router.push("/trips");\n',
        "apps/mobile/package.json": '{"dependencies": {"expo-router": "3.0.0"}}',
        "apps/mobile/app/_layout.tsx": "export default function Layout() { return null }\n",
        "apps/mobile/app/index.tsx": 'export default function Home() { return <Link href="/reports">Reports</Link> }\n',
        "apps/mobile/app/reports.tsx": "export default function Reports() { return null }\n",
        "apps/web/app/reports-link.tsx": 'export const R = () => <Link href="/reports">x</Link>;\n',
    })
    facts = code.extract(tmp_path)
    edges = _edges(facts)
    assert ("/trips", "/settings") in edges  # a component the page renders
    assert ("/settings", "/trips") in edges  # a file beside exactly one page
    assert ("/", "/reports") in edges  # the mobile app's own route
    # The web app has no /reports route: its link does not jump into the mobile app's.
    assert not [n for n in facts.navigation if n.path == "apps/web/app/reports-link.tsx"]


def test_firestore_collections_and_fastify_routes(tmp_path):
    _tree(tmp_path, {
        "package.json": '{"dependencies": {"next": "14.0.0", "firebase": "10.0.0", "fastify": "4.0.0"}}',
        "app/notes/page.tsx": """import { collection, getDocs, addDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";

export default function Notes() {
  const load = () => getDocs(collection(db, "notes"));
  const add = (note) => addDoc(collection(db, "notes"), note);
  return null;
}
""",
        "server/app.ts": """import Fastify from "fastify";
const fastify = Fastify();
fastify.route({ method: "PUT", url: "/notes/:id", handler: async () => ({}) });
""",
    })
    facts = code.extract(tmp_path)
    note = next(e for e in facts.entities if e.key == "note")
    assert (note.store, note.name) == ("api", "notes")
    assert _access(facts) == {("/notes", "note", "reads"), ("/notes", "note", "writes")}
    assert _endpoints(facts, "server") == {"PUT /notes/*"}


def test_extract_on_an_empty_or_odd_repo(tmp_path):
    assert code.extract(tmp_path) == code.CodeFacts((), (), (), (), ())
    _tree(tmp_path, {"README.md": "# nothing", "src/main.py": "print('hi')", "node_modules/x/index.js": 'fetch("/api/x")'})
    assert code.extract(tmp_path) == code.CodeFacts((), (), (), (), ())


def test_feature_map_scan_is_unchanged_by_the_screen_split(tmp_path):
    """`scan` still groups the same screens `scan_screens` keeps."""
    _tree(tmp_path, NEXT_APP)
    result = fm.scan(tmp_path)
    found = fm.scan_screens(tmp_path)
    assert result.files_seen == len(found.files)
    assert [f.key for f in result.features] == [f.key for f in fm._group(found.screens)]
    assert all(s.file for s in found.screens)


def test_each_screen_lists_the_files_that_are_its_code(next_facts):
    """What PR impact reads (`app_map/impact.py`): a component a screen renders is its code, the
    app's chrome and shell are no one's."""
    files = set(next_facts.files)
    assert ("/listings", "app/listings/page.tsx") in files
    assert ("/listings", "components/ListingCard.tsx") in files
    assert not any(rel == "components/Footer.tsx" for _, rel in files)
    node = next(n for n in payload_from_facts(next_facts, "web")["nodes"] if (n["kind"], n["key"]) == ("screen", "/listings"))
    assert "components/ListingCard.tsx" in node["detail"]["files"]


def test_expo_routes_resolve_in_their_own_package(tmp_path):
    _tree(tmp_path, {
        "apps/web/package.json": '{"dependencies": {"next": "14.0.0"}}',
        "apps/web/app/trips/page.tsx": "export default function Page() { return null }\n",
        "apps/web/app/reports-link.tsx": 'export const R = () => <Link href="/reports">x</Link>;\n',
        "apps/mobile/package.json": '{"dependencies": {"expo-router": "3.0.0", "expo": "51.0.0"}}',
        "apps/mobile/app/_layout.tsx": "export default function Layout() { return null }\n",
        "apps/mobile/app/index.tsx": 'import { TripList } from "../components/TripList";\nexport default function Home() { return <><TripList /><Link href="/reports">Reports</Link></> }\n',
        "apps/mobile/components/TripList.tsx": 'export function TripList() { return <Link href="/settings">Settings</Link> }\n',
        "apps/mobile/app/settings.tsx": "export default function Settings() { return null }\n",
        "apps/mobile/app/reports.tsx": "export default function Reports() { return null }\n",
    })
    facts = code.extract(tmp_path)
    assert set(_screens(facts)) == {"/", "/settings", "/reports", "/trips"}
    edges = _edges(facts)
    assert ("/", "/settings") in edges  # a component the screen renders
    assert ("/", "/reports") in edges  # the mobile app's own route
    # The web app has no /reports route: its link does not jump into the mobile app's.
    assert not [n for n in facts.navigation if n.path == "apps/web/app/reports-link.tsx"]


def test_firestore_collections_in_an_expo_app(tmp_path):
    _tree(tmp_path, {
        "package.json": '{"dependencies": {"expo": "51.0.0", "expo-router": "3.0.0", "firebase": "10.0.0"}}',
        "app/_layout.tsx": "export default function Layout() { return null }\n",
        "app/notes.tsx": """import { collection, getDocs, addDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";

export default function Notes() {
  const load = () => getDocs(collection(db, "notes"));
  const add = (note) => addDoc(collection(db, "notes"), note);
  return null;
}
""",
    })
    facts = code.extract(tmp_path)
    note = next(e for e in facts.entities if e.key == "note")
    assert (note.store, note.name) == ("api", "notes")
    assert _access(facts) == {("/notes", "note", "reads"), ("/notes", "note", "writes")}


def test_each_swift_screen_lists_the_files_that_are_its_code(swift_facts):
    """A component a screen renders is its code; the app's shell is no one's."""
    files = set(swift_facts.files)
    assert ("listings", "Listings/Features/Listings/ListingsView.swift") in files
    assert ("listings", "Listings/Features/Listings/ListingRow.swift") in files
    assert not any(rel == "Listings/ListingsApp.swift" for _, rel in files)
    body = payload_from_facts(swift_facts, "ios")
    node = next(n for n in body["nodes"] if (n["kind"], n["key"]) == ("screen", "listings"))
    assert "Listings/Features/Listings/ListingRow.swift" in node["detail"]["files"]


# ---------- keys (the original test_app_map.py) ----------


@pytest.mark.parametrize(("raw", "key"), [
    ("/listings/[id]/", "/listings/*"),
    ("/listings/812?tab=1", "/listings/*"),
    ("https://homes.test/listings/:id", "/listings/*"),
    ("/(app)/settings", "/settings"),
    ("/", "/"),
])
def test_routes_collapse_their_ids_whoever_names_them(raw, key):
    assert keys.route_key(raw) == key


def test_native_screens_entities_and_endpoints_have_one_key_each():
    assert {keys.screen_key(n) for n in ("ListingDetailView", "ListingDetailScreen", "ListingDetailPage", "ListingDetailViewController")} == {"listing-detail"}
    assert {keys.entity_key(n) for n in ("Listing", "listings", "listing_table")} == {"listing"}
    assert keys.entity_key("SavedSearches") == "saved_search"
    assert keys.endpoint_key("get", "/api/listings/812") == "GET /api/listings/*"


def test_a_visited_route_meets_the_declared_pattern_and_drops_a_locale():
    known = ["/listings", "/listings/*", "/listings/new"]
    assert keys.resolve_route("/listings/a-cosy-flat", known) == "/listings/*"
    assert keys.resolve_route("/listings/new", known) == "/listings/new"
    assert keys.resolve_route("/en/listings", known) == "/listings"
    assert keys.resolve_route("/about", known) == "/about"


def test_a_request_meets_the_endpoint_the_code_declares():
    known = ["GET /api/listings/*", "* /api/agents"]
    assert keys.resolve_endpoint("GET", "https://api.homes.test/api/listings/a-slug", known) == "GET /api/listings/*"
    assert keys.resolve_endpoint("POST", "/api/agents", known) == "* /api/agents"
    assert keys.resolve_endpoint("DELETE", "/api/listings/9", known) == "DELETE /api/listings/*"
    assert keys.resolve_endpoint("*", "/api/listings/9", known) == "GET /api/listings/*"  # a mock that says no method
    assert keys.resolve_endpoint("GET", "https://api.homes.test/api/v1/agents", ["* /agents"]) == "* /agents"
    assert keys.resolve_endpoint("GET", "/api/homepage-data", ["GET /homepage-data"]) == "GET /homepage-data"  # a base path


# ---------- static UI texts (code_texts) ----------


SWIFT_TEXTS = {
    "Lately/latelyApp.swift": "import SwiftUI\n@main\nstruct LatelyApp: App {\n    var body: some Scene { WindowGroup { MainTabView() } }\n}\n",
    "Lately/Views/MainTabView.swift": '''import SwiftUI

struct MainTabView: View {
    @AppStorage("lately.tab") private var tab: String = "home"
    @State private var adding = false
    var body: some View {
        TabView {
            Tab("Home", systemImage: "house.fill") { RootView() }
            Tab("Settings", systemImage: "gear") { SettingsView() }
        }
        .fullScreenCover(isPresented: $adding) { AddRoutineShell() }
    }
}

private struct AddRoutineShell: View {
    @Environment(\\.dismiss) private var dismiss
    var body: some View { AddRoutineSheet { _ in dismiss() } }
}
''',
    "Lately/Views/RootView.swift": '''import SwiftUI

struct RootView: View {
    @State private var showingSort = false
    var body: some View {
        VStack {
            Text("Lately")  // the home title
            Button("Sort routines") { showingSort = true }
            // Text("Not shown, a comment")
            if routines.isEmpty {
                Text("Nothing tracked yet.")
                Text("That's fine. Add a routine when you're ready.")
            }
            ForEach(routines) { RoutineRow(routine: $0) }
        }
        .accessibilityLabel(searching ? "Close search" : "Search")
        .alert("Delete this routine?", isPresented: $deleting) { Button("Keep it", role: .cancel) {} }
        .sheet(isPresented: $showingSort) { NavigationStack { SortSheet() } }
        .sheet(isPresented: $picking) { VStack { Avatar(); Text("Pick one") } }
    }
}

private struct RoutineRow: View {
    let routine: Routine
    var body: some View {
        Text(routine.name)
            .accessibilityLabel("\\(routine.name). \\(caption).")
        Image(systemName: "checkmark.circle")
        Text(String(localized: "row.tap"))
    }
}

struct AddRoutineSheet: View {
    var onSave: (String) -> Void
    var body: some View {
        Form {
            TextField("What do you want to remember?", text: $name)
            Text("Common things people track")
            Button("Try \\(template.name) — tap to accept") {}
        }
        .navigationTitle("New routine")
    }
}

struct SortSheet: View {
    var body: some View { List { Text("Due soon"); Text("Name (A–Z)") }.navigationTitle("Sort by") }
}

struct Avatar: View { var body: some View { Circle() } }
''',
    "Lately/Views/SettingsView.swift": '''import SwiftUI

struct SettingsView: View {
    var body: some View {
        Form {
            Section("Appearance") { Toggle("Pause all nudges", isOn: $paused) }
            Text("lately.debug.key")
            Text("Version \\(version)")
        }
        .navigationTitle("Settings")
        .confirmationDialog("Reset everything?", isPresented: $resetting) {}
    }
}
''',
    "Lately/en.lproj/Localizable.strings": '"row.tap" = "Tap to note";\n',
}


def test_swiftui_screens_say_their_static_texts(tmp_path):
    facts = code.extract(_tree(tmp_path, SWIFT_TEXTS))
    texts = {t.key: t for t in facts.texts}
    home = texts["root"]  # the Home tab's view: the tab bar holding it is no screen of its own (#467)
    assert "main-tab" not in texts
    assert {"Lately", "Sort routines", "Nothing tracked yet.", "Close search", "Search"} <= set(home.texts)
    assert "That's fine. Add a routine when you're ready." in home.texts
    assert "Tap to note" in home.texts  # a Localizable.strings key read as its English text
    assert home.alerts == ("Delete this routine?",)
    # Never shown: storage keys, symbol names, comments, key-like literals; a row's own data is no literal.
    shown = set(home.texts)
    assert not shown & {"lately.tab", "home", "house.fill", "checkmark.circle", "Not shown, a comment", "row.tap"}
    assert not any("Common things" in t for t in home.texts)  # the add sheet is its own screen
    assert texts["settings"].title == "Settings"
    assert {"Appearance", "Pause all nudges", "Version *", "Reset everything?"} <= set(texts["settings"].texts)
    assert "lately.debug.key" not in texts["settings"].texts
    assert texts["settings"].own == len(texts["settings"].texts)  # all in its own code


def test_presented_swiftui_views_become_screens(tmp_path):
    facts = code.extract(_tree(tmp_path, SWIFT_TEXTS))
    screens = _screens(facts)
    # Presented through a wrapper, and a file's view with no screen suffix; an inline sheet is none.
    assert {"add-routine", "sort"} <= set(screens)
    assert "avatar" not in screens and "add-routine-shell" not in screens
    add = next(t for t in facts.texts if t.key == "add-routine")
    assert add.title == "New routine"
    assert {"What do you want to remember?", "Common things people track", "Try * — tap to accept"} <= set(add.texts)
    assert screens["add-routine"].feature_key == screens["root"].feature_key  # the feature of the file it is declared in
    assert ("root", "settings") in _edges(facts) and ("settings", "root") in _edges(facts)  # each tab leads to the others


def test_compose_texts_resolve_string_resources(tmp_path):
    _tree(tmp_path, {
        "app/build.gradle.kts": 'dependencies { implementation("androidx.compose.ui:ui:1.6.0") }\n',
        "app/src/main/res/values/strings.xml": """<resources>
    <string name="settings_title">Settings</string>
    <string name="reset_all">Reset All Data</string>
    <string name="greeting">Good morning, %1$s</string>
    <string name="units">Measurement Unit</string>
</resources>
""",
        "app/src/main/java/com/x/ui/Nav.kt": """package com.x.ui

@Composable
fun AppNav(navController: NavHostController) {
    NavHost(navController, startDestination = "dashboard") {
        composable("dashboard") { DashboardScreen(navController) }
        composable("settings") { SettingsScreen(onBack = { navController.popBackStack() }) }
    }
}
""",
        "app/src/main/java/com/x/ui/DashboardScreen.kt": """package com.x.ui

@Composable
fun DashboardScreen(navController: NavHostController) {
    Column {
        Text(stringResource(R.string.greeting, name))
        Text("Add new entry", modifier = Modifier.testTag("add_entry"))
        Icon(Icons.Default.Add, contentDescription = "Open features menu")
        Log.d("Dashboard", "rendered dashboard")
    }
}
""",
        "app/src/main/java/com/x/ui/SettingsScreen.kt": """package com.x.ui

@Composable
fun SettingsScreen(onBack: () -> Unit) {
    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.settings_title)) }) }) {
        UnitRow()
        AlertDialog(onDismissRequest = {}, title = { Text("Reset All Data") }, confirmButton = {})
    }
}

@Composable
private fun UnitRow() { Text(stringResource(R.string.units)); Text("oz") }
""",
    })
    facts = code.extract(tmp_path)
    texts = {t.key: t for t in facts.texts}
    dash = texts["/dashboard"]
    assert {"Good morning, *", "Add new entry", "Open features menu"} <= set(dash.texts)
    assert "rendered dashboard" not in dash.texts and "add_entry" not in dash.texts
    settings = texts["/settings"]
    assert settings.title == "Settings"  # the top app bar's title, through strings.xml
    assert "Measurement Unit" in settings.texts  # a composable it renders
    assert settings.alerts == ("Reset All Data",)


@pytest.mark.parametrize(("raw", "text"), [
    ("Nothing tracked yet.", "Nothing tracked yet."),
    ("Try \x00", None),  # too few words of its own to tell screens apart
    ("Delete \x00?", "Delete *?"),
    ("\x00. \x00.", None),  # a pattern with no words of its own
    ("house.fill", None),
    ("lately.colorTheme", None),
    ("selectedTab", None),
    ("snug-calendar", None),
    ("AppIcon-Sunrise", None),
    ("home", None),  # a lone lower-case word is a key, not a label
    ("S", None),  # an index letter
    ("MMM d, yyyy", None),  # a date format
    ("Pre-dusk", "Pre-dusk"),
    ("%d notes", "* notes"),
    ("DANGER", "DANGER"),
])
def test_ui_text_keeps_words_and_drops_keys(raw, text):
    from orcha_cli.qa.codemap.code_texts import ui_text

    assert ui_text(raw) == text


def test_literals_skip_comments_and_read_interpolations():
    from orcha_cli.qa.codemap.code_texts import HOLE, literals

    swift = 'let a = "Hi \\(name(of: "x"))!" // "not this"\n/* "nor this" */ let b = "B"'
    assert [v for _, _, v in literals(swift, "swift")] == [f"Hi {HOLE}!", "B"]
    kotlin = 'val c = \'"\'\nval s = "Hello $name and ${user.id}"'
    assert [v for _, _, v in literals(kotlin, "kotlin")] == [f"Hello {HOLE} and {HOLE}"]
