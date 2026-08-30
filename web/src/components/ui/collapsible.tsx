import * as CollapsiblePrimitive from "radix-ui"

function Collapsible({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Collapsible.Root>) {
  return (
    <CollapsiblePrimitive.Collapsible.Root data-slot="collapsible" {...props} />
  )
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Collapsible.Trigger>) {
  return (
    <CollapsiblePrimitive.Collapsible.Trigger
      data-slot="collapsible-trigger"
      {...props}
    />
  )
}

function CollapsibleContent({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Collapsible.Content>) {
  return (
    <CollapsiblePrimitive.Collapsible.Content
      data-slot="collapsible-content"
      {...props}
    />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
