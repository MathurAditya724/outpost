import { ErrorMsg } from "@/components/error-msg"
import { LastUpdated } from "@/components/last-updated"
import { LoadingSkeleton } from "@/components/loading-skeleton"
import { showToast } from "@/components/toast"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useApiClient } from "@/hooks/use-api"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, Plus, Trash2 } from "lucide-react"
import { useState } from "react"

export default function AllowlistPage() {
  const client = useApiClient()
  const queryClient = useQueryClient()

  const { data, isLoading, isFetching, dataUpdatedAt, error, refetch } = useQuery({
    queryKey: ["allowlist"],
    queryFn: () => client!.getAllowlist(),
    enabled: !!client,
  })

  const mutation = useMutation({
    mutationFn: (opts: { allowed_orgs?: string[]; allowed_repos?: string[] }) => client!.setAllowlist(opts),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["allowlist"] })
      showToast("Allowlist updated")
    },
    onError: (err) => {
      showToast(err instanceof Error ? err.message : "Failed to update allowlist", "error")
    },
  })

  function addOrg(value: string) {
    const trimmed = value.trim().toLowerCase()
    if (!trimmed || !data) return
    if (data.allowed_orgs.includes(trimmed)) {
      showToast("Organization already in the list", "error")
      return
    }
    mutation.mutate({ allowed_orgs: [...data.allowed_orgs, trimmed] })
  }

  function removeOrg(org: string) {
    if (!data) return
    mutation.mutate({ allowed_orgs: data.allowed_orgs.filter((o) => o !== org) })
  }

  function addRepo(value: string) {
    const trimmed = value.trim().toLowerCase()
    if (!trimmed || !data) return
    if (!trimmed.includes("/")) {
      showToast("Repository must be in owner/repo format", "error")
      return
    }
    if (data.allowed_repos.includes(trimmed)) {
      showToast("Repository already in the list", "error")
      return
    }
    mutation.mutate({ allowed_repos: [...data.allowed_repos, trimmed] })
  }

  function removeRepo(repo: string) {
    if (!data) return
    mutation.mutate({ allowed_repos: data.allowed_repos.filter((r) => r !== repo) })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold">Allowlist</h1>
        <LastUpdated dataUpdatedAt={dataUpdatedAt} isFetching={isFetching} onRefresh={() => refetch()} />
      </div>

      {isLoading && !data ? (
        <LoadingSkeleton rows={6} />
      ) : error ? (
        <ErrorMsg msg={error.message} />
      ) : data ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <AllowlistCard
            title="Allowed Organizations"
            description="Events from repositories owned by these organizations will be dispatched. Empty list allows all."
            items={data.allowed_orgs}
            placeholder="e.g. my-org"
            onAdd={addOrg}
            onRemove={removeOrg}
            isPending={mutation.isPending}
          />
          <AllowlistCard
            title="Allowed Repositories"
            description="Events from these specific repositories will be dispatched. Use owner/repo format."
            items={data.allowed_repos}
            placeholder="e.g. owner/repo"
            onAdd={addRepo}
            onRemove={removeRepo}
            isPending={mutation.isPending}
          />
        </div>
      ) : null}
    </div>
  )
}

function AllowlistCard({
  title,
  description,
  items,
  placeholder,
  onAdd,
  onRemove,
  isPending,
}: {
  title: string
  description: string
  items: string[]
  placeholder: string
  onAdd: (value: string) => void
  onRemove: (value: string) => void
  isPending: boolean
}) {
  const [value, setValue] = useState("")

  function handleAdd() {
    if (!value.trim()) return
    onAdd(value)
    setValue("")
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                handleAdd()
              }
            }}
            disabled={isPending}
          />
          <Button size="sm" onClick={handleAdd} disabled={isPending || !value.trim()}>
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add
          </Button>
        </div>

        {items.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No entries. All repositories are allowed when the list is empty.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {items.map((item) => (
              <Badge key={item} variant="secondary" className="gap-1 py-1 pl-2.5 pr-1">
                <span className="font-mono text-xs">{item}</span>
                <button
                  type="button"
                  onClick={() => onRemove(item)}
                  disabled={isPending}
                  className="ml-0.5 rounded p-0.5 hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                  title={`Remove ${item}`}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
