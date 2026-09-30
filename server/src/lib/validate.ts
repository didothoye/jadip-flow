import { z, type ZodTypeAny } from 'zod';
import { badRequest } from './errors.js';

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const i = r.error.issues[0];
    throw badRequest(`Champ invalide « ${i.path.join('.') || 'corps'} » : ${i.message}`);
  }
  return r.data;
}

export const uuid = z.string().uuid();
export const idParam = z.object({ id: z.string().uuid() });
export const numIdParam = z.object({ id: z.coerce.number().int().positive() });
export { z };
