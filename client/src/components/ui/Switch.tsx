import * as RadixSwitch from "@radix-ui/react-switch";
import type { JSX } from "react";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  id?: string;
  "data-testid"?: string;
}

/** Token-styled Radix switch — replaces bare checkboxes in settings. */
export function Switch({
  checked,
  onChange,
  id,
  "data-testid": testId,
}: SwitchProps): JSX.Element {
  return (
    <RadixSwitch.Root
      className="switch"
      checked={checked}
      onCheckedChange={onChange}
      id={id}
      data-testid={testId}
    >
      <RadixSwitch.Thumb className="switch-thumb" />
    </RadixSwitch.Root>
  );
}
