package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.StatusDomain
import io.openorcha.mobile.ui.components.StatusPill

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContainersHomeScreen(
    state: OrchaUiState,
    onAdd: () -> Unit,
    onOpen: (String) -> Unit,
    onForget: (String) -> Unit,
    onRefresh: () -> Unit,
) {
    Scaffold(
        topBar = {
            LargeTopAppBar(
                title = {
                    Column {
                        Text("Orcha")
                        Text(
                            "My Orchas",
                            style = MaterialTheme.typography.labelLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = onRefresh) {
                        Icon(Icons.Rounded.Refresh, contentDescription = "Refresh")
                    }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = onAdd) {
                Icon(Icons.Rounded.Add, contentDescription = "Add Orcha")
            }
        },
    ) { padding ->
        if (state.containers.isEmpty()) {
            EmptyContainers(modifier = Modifier.padding(padding), onAdd = onAdd)
        } else {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(state.containers, key = { it.id }) { container ->
                    ContainerCard(container, onOpen, onForget)
                }
            }
        }
    }
}

@Composable
private fun EmptyContainers(modifier: Modifier = Modifier, onAdd: () -> Unit) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.Start,
    ) {
        Text("Add your Orcha", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(10.dp))
        Text(
            "Connect to the Orcha running on your computer. QR pairing is waiting on server support, so this slice starts with manual address entry.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(20.dp))
        androidx.compose.material3.Button(onClick = onAdd) {
            Text("Add local Orcha")
        }
    }
}

@Composable
private fun ContainerCard(
    container: StoredContainer,
    onOpen: (String) -> Unit,
    onForget: (String) -> Unit,
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onOpen(container.id) },
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        shape = MaterialTheme.shapes.medium,
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(container.displayName, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text(
                    container.baseUrl,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(10.dp))
                StatusPill("saved", StatusDomain.Connection)
            }
            IconButton(onClick = { onForget(container.id) }) {
                Icon(Icons.Rounded.Delete, contentDescription = "Forget")
            }
        }
    }
}

