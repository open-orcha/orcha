package com.homes.app.api

interface HomesApi {
    @GET("v1/listings")
    suspend fun listings(): List<ListingDto>

    @POST("v1/listings/{id}/favorite")
    suspend fun favorite(@Path("id") id: String)
}
