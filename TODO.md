# TODO

- [ ] **Soft delete** — on a delete request, do not physically remove the row.
  Instead mark it as deleted in the DB (e.g. add a `deleted_at` column, set it on
  delete) and exclude soft-deleted rows from the memo list / fetches.
