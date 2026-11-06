import { defineConfig, configDefaults } from "vitest/config";

// contracts/lib holds git submodules (forge-std, OpenZeppelin) whose own JS
// tests need Hardhat. Solidity is tested with forge, not vitest.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "contracts/**"],
  },
});
