import { defineRouteConfig } from "@medusajs/admin-sdk"
import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Container,
  Heading,
  Text,
  Button,
  Table,
  Badge,
  IconButton,
  DropdownMenu,
  toast,
  usePrompt,
} from "@medusajs/ui"
import { EllipsisHorizontal, PencilSquare, Plus, Trash } from "@medusajs/icons"
import { sdk } from "../../../lib/sdk"
import { IntegrationDrawer, OngoingIntegration } from "./integration-drawer"

const IntegrationsSettingsPage = () => {
  const [drawerMode, setDrawerMode] = useState<"create" | "edit" | null>(null)
  const [editing, setEditing] = useState<OngoingIntegration | null>(null)
  const queryClient = useQueryClient()
  const prompt = usePrompt()

  // Display query — loads on mount, no `enabled` gate.
  const { data, isLoading } = useQuery({
    queryFn: () =>
      sdk.client.fetch<{ integrations: OngoingIntegration[] }>("/admin/ongoing/integrations"),
    queryKey: ["ongoing-integrations"],
  })

  const handleDelete = async (integration: OngoingIntegration) => {
    const confirmed = await prompt({
      title: "Delete integration",
      description:
        `Deleting "${integration.credential_key}" only removes the Medusa-side integration row. ` +
        "The fulfillment set, service zone, and shipping option created for this stock location " +
        "are NOT removed and must be cleaned up manually if no longer needed.",
      variant: "danger",
      confirmText: "Delete",
      cancelText: "Cancel",
    })
    if (!confirmed) {
      return
    }
    try {
      await sdk.client.fetch(`/admin/ongoing/integrations/${integration.id}`, {
        method: "DELETE",
      })
      toast.success("Integration deleted")
      queryClient.invalidateQueries({ queryKey: ["ongoing-integrations"] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete integration")
    }
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h1">Ongoing Warehouse</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Manage Ongoing integrations, stock location assignments, and sync settings.
          </Text>
        </div>
        <Button
          size="small"
          variant="secondary"
          onClick={() => {
            setEditing(null)
            setDrawerMode("create")
          }}
        >
          <Plus />
          Create integration
        </Button>
      </div>

      {isLoading ? (
        <div className="px-6 py-4">
          <Text size="small">Loading...</Text>
        </div>
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Credential key</Table.HeaderCell>
              <Table.HeaderCell>Stock location</Table.HeaderCell>
              <Table.HeaderCell>Enabled</Table.HeaderCell>
              <Table.HeaderCell>Reconcile mode</Table.HeaderCell>
              <Table.HeaderCell></Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {(data?.integrations ?? []).map((integration) => (
              <Table.Row key={integration.id}>
                <Table.Cell>{integration.credential_key}</Table.Cell>
                <Table.Cell>{integration.stock_location_id}</Table.Cell>
                <Table.Cell>
                  <Badge color={integration.enabled ? "green" : "grey"}>
                    {integration.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </Table.Cell>
                <Table.Cell>{integration.stock_reconcile_mode}</Table.Cell>
                <Table.Cell>
                  <DropdownMenu>
                    <DropdownMenu.Trigger asChild>
                      <IconButton size="small" variant="transparent">
                        <EllipsisHorizontal />
                      </IconButton>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content>
                      <DropdownMenu.Item
                        className="gap-x-2"
                        onClick={() => {
                          setEditing(integration)
                          setDrawerMode("edit")
                        }}
                      >
                        <PencilSquare className="text-ui-fg-subtle" />
                        Edit
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item className="gap-x-2" onClick={() => handleDelete(integration)}>
                        <Trash className="text-ui-fg-subtle" />
                        Delete
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}

      <IntegrationDrawer mode={drawerMode} integration={editing} onClose={() => setDrawerMode(null)} />
    </Container>
  )
}

export const config = defineRouteConfig({
  label: "Ongoing Warehouse",
})

export default IntegrationsSettingsPage
