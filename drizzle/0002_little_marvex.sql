ALTER TABLE "orders" ADD COLUMN "ls_sale_line_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_ls_sale_line_id_unique" UNIQUE("ls_sale_line_id");