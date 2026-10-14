import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

const smartRouterID = "smart-router"
const defaultDecisionModel = "jev-1.13.0"

export function isSmartRouter(model: { modelID: string } | undefined) {
  return model?.modelID === smartRouterID
}

export function DialogVariant() {
  const local = useLocal()
  const dialog = useDialog()
  // Smart Router variants are the decision models that choose which model serves each turn.
  const smart = createMemo(() => isSmartRouter(local.model.current()))

  const options = createMemo(() => [
    {
      value: "default",
      title: smart() ? `Default (${defaultDecisionModel})` : "Default",
      onSelect: () => {
        dialog.clear()
        local.model.variant.set(undefined)
      },
    },
    ...local.model.variant
      .list()
      .filter((variant) => variant !== "default")
      .map((variant) => ({
        value: variant,
        title: variant,
        onSelect: () => {
          dialog.clear()
          local.model.variant.set(variant)
        },
      })),
  ])

  return (
    <DialogSelect<string>
      options={options()}
      title={smart() ? "Select Smart Router decision model" : "Select variant"}
      current={local.model.variant.current() ?? "default"}
      flat={true}
    />
  )
}
