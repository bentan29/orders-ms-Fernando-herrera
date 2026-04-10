import { Controller, ParseUUIDPipe } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderPaginationDto, PaidOrderDto } from './dto';
import { ChangeOrderStatusDto } from './dto/change-order-status.dto';

@Controller()
export class OrdersController {
  
  constructor(private readonly ordersService: OrdersService) {}

  @MessagePattern({ cmd: 'createOrder' })
  async create(@Payload() createOrderDto: CreateOrderDto) {

    //✅ 1. Creamos la Orden en la base de datos
    const order = await this.ordersService.create(createOrderDto);
    //✅ 2. Procesamos el Pago (Stripe) - Ni bien tengamos la orden creada es cuando vamos a crear el pago
    const paymentSession = await this.ordersService.createPaymentSession(order)

    return {
      order,
      paymentSession 
    }
  }

  @MessagePattern({ cmd: 'findAllOrders' })
  findAll(@Payload() orderPaginationDto: OrderPaginationDto) {
    return this.ordersService.findAll(orderPaginationDto);
  }

  @MessagePattern({ cmd: 'find_one_order' })
  findOne(@Payload('id', ParseUUIDPipe) id: string) {
    return this.ordersService.findOne(id);
  }

  @MessagePattern({ cmd: 'changeOrderStatus' })
  changeOrderStatus(@Payload() changeOrderStatusDto: ChangeOrderStatusDto) {
    return this.ordersService.changeOrderStatus(changeOrderStatusDto)
  }


  //  ---- Diferencia entre @MessagePattern y @EventPattern ----
  //  - @MessagePattern → envías un mensaje y esperás respuesta (request/response).
  //  - @EventPattern → emitís un evento y no hay respuesta (fire & forget).

  //* -- Aca recibimos la respuesta al pagar la orden que viene del stripeWebhook del payment.service
  @EventPattern('payment.succeeded')
  paidOrder(@Payload() paidOrderDto: PaidOrderDto) {
    return this.ordersService.markOrderAsPaid(paidOrderDto)
  }
}
