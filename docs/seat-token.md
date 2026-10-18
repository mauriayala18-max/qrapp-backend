# Seat token — contrato para los frontends (app y web)

Build: `seat-token-2026-10-18` (visible en `GET /api/healthz` → `build`).

## Qué es

El **seat token** es la credencial privada de UN comensal (`session_participants`) en UNA
sesión de mesa. Reemplaza al `participant_id` como prueba de identidad: el `participant_id`
deja de ser secreto (aparece en listas, pedidos, etc.) y el nombre visible tampoco prueba nada.

- 32 bytes aleatorios en base64url (43 caracteres). Opaco: no lo parseen.
- El servidor sólo guarda su sha256. **Si se pierde, no se puede recuperar**: hay que volver a
  unirse a la mesa (ver "Recuperación").
- Vale sólo para esa sesión. Cuando la mesa se cierra, el token muere (409 `SESSION_NOT_ACTIVE`),
  y en la siguiente sesión de la misma mesa es inválido.

## Dónde viene el token

Se devuelve **una sola vez** por emisión, en el body de la respuesta, campo `data.seat_token`:

| Endpoint | Campo |
|---|---|
| `POST /api/v1/sessions/join` (PIN o token QR) | `data.seat_token` (+ `data.participant_id`) |
| `POST /api/v1/tables/:tableId/scan` (QR fijo `/t/{table_id}`) | `data.seat_token` (+ `data.participant_id`) |
| `POST /api/v1/sessions/scan` | `data.seat_token` (+ `data.participant_id`, nuevo) |
| Cualquier endpoint protegido, emisión "lazy" (ver abajo) | header `X-Seat-Token-Issued` **y** `data.seat_token` |

**Cada join emite un token nuevo** y el anterior de ese participante deja de funcionar. Guarden
siempre el último recibido (reemplazando el anterior), asociado al `session_id`.

`data.seat_token` es `null` sólo si el SQL de la migración todavía no se corrió en la base
(`GET /api/healthz` → `seat_tokens.columns = "missing_columns"`); en ese caso el backend se
comporta como antes y no exige nada.

### Dónde guardarlo
- App: almacenamiento seguro (SecureStore/Keychain), clave por `session_id`.
- Web: `localStorage` (o `sessionStorage`) por `session_id`. No en la URL, no en logs, no en analytics.

## Cómo enviarlo

Header en cada request protegido:

```
X-Seat-Token: <seat_token>
```

- En la app, además del `Authorization: Bearer <jwt>` de siempre (no lo reemplaza).
- En la web anónima, sólo el `X-Seat-Token`.
- El body `participant_id` **ya no es necesario** cuando se manda el token: el participante sale
  del token. Si se manda uno distinto, se ignora (se usa el del token).
- CORS: `X-Seat-Token` está permitido como request header; `X-Seat-Token-Issued` está expuesto
  para que JS lo pueda leer.

## Endpoints que exigen el token

Todas las acciones de comensal que cambian estado. Staff (empleado activo asignado a la sucursal
de la mesa) **no** necesita token donde la columna "Staff" dice "exento": sigue con su JWT de empleado.

| Método y ruta | Quién | Staff |
|---|---|---|
| `POST /api/v1/orders` (pedido digital) | web anónima o app | — |
| `POST /api/v1/orders/:orderId/cancel` (cancelar pedido/ítem propio) | app (JWT + token) | exento |
| `POST /api/v1/payments` (pago / pedido de pago en efectivo/POS) | web anónima o app | exento |
| `POST /api/v1/sessions/:sessionId/call-waiter` | web anónima o app | — |
| `POST /api/v1/sessions/:sessionId/expulsions` (proponer expulsión) | app (JWT + token) | — (staff usa `/expulsions/staff`) |
| `POST /api/v1/expulsions/:proposalId/vote` | app (JWT + token) | — |
| `POST /api/v1/expulsions/:proposalId/cancel` | app (JWT + token) | — |
| `POST /api/v1/sessions/:sessionId/lock` (sellar la mesa / voto de sellado) | app (JWT + token) | exento |
| `POST /api/v1/sessions/:sessionId/split` | app (JWT + token) | exento |
| `POST /api/v1/sessions/:sessionId/payment-link` | app (JWT + token) | — |
| `POST /api/v1/splits/:splitId/claim` | app (JWT + token) | — |

"app (JWT + token)" = esas rutas ya exigían login antes; ahora además exigen el token del
asiento de ESA cuenta en esa sesión.

**No** exigen token: lecturas (menú, `GET /sessions/:id`, cuenta, pagos, splits, links), joins,
endpoints de staff/panel, `POST /api/v1/pay/:linkId/complete` (el link de pago es una capacidad
compartible a propósito), y acciones de cuenta no ligadas a un asiento (pedidos anticipados,
ratings, puntos, cupones, promociones, reservas).

`GET /sessions/:sessionId` sigue aceptando `?participant_id=` para la web anónima (sin cambios).

## Errores

Formato habitual `{ "error": true, "message": "...", "code": "..." }`.

| HTTP | `code` | Significado | Qué hacer |
|---|---|---|---|
| 401 | `SEAT_TOKEN_MISSING` | Falta `X-Seat-Token` y el asiento ya tiene token | Mandar el token guardado; si no hay, volver a unirse |
| 403 | `SEAT_TOKEN_INVALID` | Token desconocido, de otra mesa/sesión, o (con JWT) de un asiento que no es el de esa cuenta | Borrar el token guardado y volver a unirse |
| 403 | `PARTICIPANT_INACTIVE` | El asiento fue desconectado o expulsado | Mostrar "ya no estás en la mesa" |
| 401 | `AUTH_REQUIRED` | El asiento tiene cuenta y falta su JWT | Loguear |
| 409 | `SESSION_NOT_ACTIVE` | La mesa ya se cerró | Volver al inicio / escanear de nuevo |
| 404 | `SESSION_NOT_FOUND` | Sesión inexistente | — |
| 409 | `NAME_TAKEN` | (join) Ese nombre ya lo tiene otro asiento de la mesa | Pedir otro nombre |

## Join y re-join

### App (con JWT)
Re-join a la misma sesión = mismo participante, **token nuevo** (el viejo deja de servir). El JWT
prueba la identidad; no hace falta mandar el token viejo.

### Web anónima (sin JWT)
- **Primera vez**: `POST /sessions/join` (o `/tables/:id/scan`) con `name` → participante nuevo + token.
- **Re-join (recarga de página, volver a escanear)**: mandar el token guardado en el header
  `X-Seat-Token` en el request de join. Si es válido para esa sesión → **mismo participante**
  (mismo `participant_id`, sus pedidos), token rotado (guardar el nuevo). El `name` del body se
  ignora en ese caso (se conserva el del asiento).
- **Sin token válido** y con un nombre que ya tiene otro asiento de esa sesión (activo o que se fue)
  → `409 NAME_TAKEN`. Pedirle al usuario otro nombre. Nunca se entrega el asiento de otro por
  escribir su nombre.
- Un token inválido o de otra sesión en el join se trata como "sin token" (no da error por sí solo).
- Mesa sellada (`entry_locked`): sólo entran los que prueban su asiento (JWT de su cuenta o su
  seat token). Un nombre solo no alcanza.

### Recuperación
Si la web perdió el token (borró storage, otro dispositivo), no puede volver a ese asiento:
tiene que unirse con otro nombre. Lo que pidió antes sigue en la cuenta de la mesa.

## Compatibilidad: emisión "lazy"

Participantes creados antes de este deploy no tienen token (hash NULL). En su próximo request
protegido **sin** `X-Seat-Token`:

1. Se identifica el asiento como antes: `participant_id` en el body (web anónima) o el JWT (app).
2. El request se procesa normalmente y la respuesta trae el token nuevo en el header
   `X-Seat-Token-Issued` **y** en `data.seat_token` (si `data` es un objeto). El header viene
   incluso si el request terminó en error de negocio (en ese caso también como `seat_token`
   en el body de error).
3. Desde ahí, ese asiento exige el token. Un segundo request sin token → `401 SEAT_TOKEN_MISSING`.

Por eso: **en cualquier respuesta, si viene `X-Seat-Token-Issued`, guardarlo** (reemplaza al anterior).

Asientos con cuenta (user_id) sólo reciben el token lazy si el JWT es de esa cuenta. Si el request trae
JWT, sólo puede actuar como el asiento de esa cuenta: ni con token ni sin token se puede actuar como el
asiento de otro comensal (aunque sea un invitado anónimo).

## Flag de rollback

`SEAT_TOKEN_ENFORCE` (env del backend, default `"true"`). Con `"false"` los errores
`SEAT_TOKEN_MISSING` / `SEAT_TOKEN_INVALID` se loguean como warning y el request sigue con las
reglas anteriores (incluido el re-join por nombre). Los tokens se siguen emitiendo.
`GET /api/healthz` → `seat_tokens.enforce` muestra el valor efectivo.

## Checklist para los clientes

1. Guardar `data.seat_token` de cada join (por `session_id`), reemplazando el anterior.
2. Mandar `X-Seat-Token` en todos los endpoints de la tabla de arriba (y en los joins/re-joins).
3. Leer `X-Seat-Token-Issued` en cualquier respuesta y guardarlo si viene.
4. Manejar `NAME_TAKEN` en el join (pedir otro nombre).
5. `SEAT_TOKEN_INVALID` / `SEAT_TOKEN_MISSING` sin token guardado → volver a la pantalla de join.
6. Borrar el token al cerrarse la mesa (`SESSION_NOT_ACTIVE`).
