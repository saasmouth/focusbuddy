Field hooks for the v2 drawing model, one file per package (e.g. stroke.ts).
Each file calls registerDrawField(scope, key, normalize) from ../fieldHooks at
module load; normalize.ts loads every *.ts file here automatically, in the
renderer, the main process and tests. See documents/draw/README.md.
