{
  description = "giggle: development shell (toolchain only; Python and JS deps come from uv and pnpm)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages =
            with pkgs;
            [
              uv
              nodejs_24
              pnpm
              gnumake
              # Local secrets: scripts/with-secrets (sops + an age key, Secure Enclave on Macs).
              sops
              age
            ]
            ++ lib.optionals stdenv.hostPlatform.isDarwin [ age-plugin-se ];
          env = {
            # Use uv's standalone Python (pinned in .python-version), not nixpkgs' Python:
            # manylinux wheels such as onnxruntime load reliably against it on the CI runner.
            UV_PYTHON_PREFERENCE = "only-managed";
            UV_PYTHON_DOWNLOADS = "automatic";
          };
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-rfc-style);
    };
}
