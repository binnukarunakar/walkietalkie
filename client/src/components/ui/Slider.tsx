import * as RadixSlider from "@radix-ui/react-slider";
import type { JSX } from "react";

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  "aria-label": string;
  className?: string;
}

/** Token-styled Radix slider — keyboard accessible, consistent cross-browser. */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  "aria-label": ariaLabel,
  className,
}: SliderProps): JSX.Element {
  return (
    <RadixSlider.Root
      className={`slider ${className ?? ""}`}
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(values) => {
        if (values[0] !== undefined) {
          onChange(values[0]);
        }
      }}
    >
      <RadixSlider.Track className="slider-track">
        <RadixSlider.Range className="slider-range" />
      </RadixSlider.Track>
      <RadixSlider.Thumb className="slider-thumb" aria-label={ariaLabel} />
    </RadixSlider.Root>
  );
}
