import type { ScenarioInput } from "../../dist/types/index.js";

export const withSharedVariants = (scneario: ScenarioInput, options?: { docsPage?: string }): ScenarioInput => {
    
    const variants = [
        { name: "baseline-no-ctx" },
        {
            name: "with-docs",
            prompt: scneario.prompt + ` Reference the AXIS documentation at ${options?.docsPage || 'https://axis.run'}.`
        },
        ...scneario.variants || []
    ]

    return { ...scneario, variants };
}