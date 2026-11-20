# Order lifecycle

```mermaid
stateDiagram-v2
  direction LR
  [*] --> Pending
  Pending --> Paid: payment ok
  Pending --> Cancelled: payment failed
  Paid --> Packed
  Packed --> Shipped
  Shipped --> Delivered
  Delivered --> [*]
  Paid --> Refunded: shopper cancels
  Shipped --> Returned: return window
  Returned --> Refunded
  Refunded --> [*]
  Cancelled --> [*]
```
