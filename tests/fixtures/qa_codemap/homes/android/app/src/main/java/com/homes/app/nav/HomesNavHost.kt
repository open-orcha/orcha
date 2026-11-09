package com.homes.app.nav

@Composable
fun HomesNavHost(navController: NavHostController = rememberNavController()) {
    NavHost(navController, startDestination = "listings") {
        composable("listings") {
            ListingsScreen(onOpen = { id -> navController.navigate("listing/$id") })
        }
        composable("listing/{id}") {
            ListingDetailScreen()
        }
    }
}
