import { ChangeOrderStatusDto } from './dto/change-order-status.dto';
import { OrderPaginationDto } from './dto/order-pagination.dto';
import { HttpStatus, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CreateOrderDto } from './dto/create-order.dto';
import { PrismaClient } from '@prisma/client';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { NATS_SERVICE,} from 'src/config';
import { firstValueFrom } from 'rxjs';
import { ProductInterface } from 'src/interfaces/Product.interface';
import { OrderWithProducts } from './interfaces/order-with-products.interface';
import { PaidOrderDto } from './dto';


@Injectable()
export class OrdersService extends PrismaClient implements OnModuleInit {
 
  constructor(
    //* Conexion con nats, que vamos a usar para el microservicio de products
    @Inject(NATS_SERVICE) private readonly natsClient: ClientProxy 
  ){
    super()
  }

  private readonly logger = new Logger('OrderService');

  async onModuleInit() {
    await this.$connect()
    this.logger.log('Database Orders Connected🌭')
  }
  

  //? ---------- Crear
  async create(createOrderDto: CreateOrderDto) {

    try {

      //✅ 1. Tomamos los id de los productos de la orden
      const productsIds = createOrderDto.items.map(item => item.productId)

      //- Tomamos los productos directos de la BD de Products
      const products: ProductInterface[] = await firstValueFrom(
        //?- Comunicacion con el microservicio de products
        this.natsClient.send({cmd: 'validate_products'}, productsIds) 
      )

      //-  products, van a ser los productos que tenemos en el carrito pero con los valores tomados de la Base de datos
      //    nunca! le pasamos el precio desde el front por que puede ser modificado

      //✅ 2. Calculos de los valores del precio total
      const totalAmount = createOrderDto.items.reduce((acc, orderItem) => {
        //- Tomamos el precio de cada prodcuto tal cual esta en BD
        const price = products.find( 
          prod => prod.id === orderItem.productId
        )!.price;
        //- Calculamos
        return acc + price * orderItem.quantity
      },0)

      //✅ 3. Calculamos cantidad de items total
      const totalItems = createOrderDto.items.reduce((acc, orderItem) => {
        return acc + orderItem.quantity;
      }, 0);

      //✅ 4. Creamos una transaccion de base de datos
      const order = await this.order.create({
        data: {
          totalAmount: totalAmount,
          totalItems: totalItems,
          OrderItem: {
            createMany: {
              data: createOrderDto.items.map((orderItem) => ({
                price: products.find(prod => prod.id === orderItem.productId)!.price,
                productId: orderItem.productId,
                quantity: orderItem.quantity
              }))
            }
          }
        },
        include: {
          OrderItem: {
            select: {
              price: true,
              quantity: true,
              productId: true
            }
          }
        }
      })

      return {
        ...order,
        OrderItem: order.OrderItem.map((orderItem) => ({
          ...orderItem,
          name: products.find(prod => prod.id === orderItem.productId)!.name //- agregamos el nomber
        }))
      };


    } catch(error) {

      // Relación no encontrada (ej: foreign key inválida) //- esto sirve cuando tenemos product relacionado con otra tabla por ejemplo
      if (error.code === 'P2003') {
        throw new RpcException({
          message: `Related record not found`,
          status: HttpStatus.BAD_REQUEST
        });
      }

      throw new RpcException({
        message: 'Check logs',
        status: HttpStatus.BAD_REQUEST
        // status: HttpStatus.INTERNAL_SERVER_ERROR
      })
    }
  
  }


  //? ---------- Tomamos todos
  async findAll(orderPaginationDto: OrderPaginationDto) {

    const total = await this.order.count({
      where: {
        status: orderPaginationDto.status
      }
    });

    const currentPage = orderPaginationDto.page;
    const perPage = orderPaginationDto.limit;

    console.log('orderssssssssssss')

    return {
      data: await this.order.findMany({
        skip: (currentPage! - 1) * perPage, //- cantidad que salteamos
        take: perPage, //- cantidad que tomamos
        where: {
          status: orderPaginationDto.status
        }
      }),
      metadata: {
        total,
        currentPage,
        totalPages: Math.ceil(total / perPage)
      }
    }
  }


  //? ---------- Tomamos una orden
  async findOne(id: string) {

    const order = await this.order.findFirst({
      where: {id},
      include: {
        OrderItem: {
          select: {
            price: true,
            quantity: true,
            productId: true
          }
        }
      }
    })

    const idsProducts = order?.OrderItem.map( product => product.productId)

    const productsInOrder: ProductInterface[] = await firstValueFrom(
      this.natsClient.send({cmd: 'validate_products'}, idsProducts)
    ) 

    if(!order)
      throw new RpcException({ //- Para retornar error en microservicios
        message: `Order with id ${id} not found`,
        status: HttpStatus.BAD_REQUEST //- Pasamos el numero del error
        //status: HttpStatus.NOT_FOUND  // ✅ en vez de BAD_REQUEST
      })

    return {
      ...order,
      OrderItem: order.OrderItem.map((orderItem) => ({
        ...orderItem,
        name: productsInOrder.find(prod => prod.id === orderItem.productId)!.name //- agregamos el nomber
      }))
    }
  }


  //? ---------- Cambiamos el status de la orden
  async changeOrderStatus(changeOrderStatusDto: ChangeOrderStatusDto ) {

    const { id, status } = changeOrderStatusDto;

    const order = await this.findOne(id);

    //- si tenemos el mimos estado retoramos como estaba
    if(order.status === status) return order

    return this.order.update({
      where: {id},
      data: {status: status}
    })


  }


 
  //* ----------- Este Metodo va a ser llamado desde orderController luego de haberse creado la orden 
  async createPaymentSession(order: OrderWithProducts) {
    
    const paymentSession = await firstValueFrom(
      //- Emitimos al microservicio de los Payments
      this.natsClient.send('create.payment.session', {
        orderId: order.id,
        currency: 'usd',
        items: order.OrderItem.map( item => ({
          name: item.name,
          price: item.price,
          quantity: item.quantity
        }))

      })
    )

    return paymentSession;

  }


  //* ----------- Pago de la orden, en el curso lo nombra paidOrder
  async markOrderAsPaid(paidOrderDto: PaidOrderDto) {


    this.logger.log('order Paiddd', paidOrderDto);

    //?- Actualizamos en base de datos la orden pagada
    const order = await this.order.update({
      where: { id: paidOrderDto.orderId},
      data: {
        status: 'PAID',
        paid: true,
        paidAt: new Date(),
        stripeChargeId: paidOrderDto.stripePaymentId,
        OrderReceipt: {  //?- Actualizamos el recivo del pago en la tabla relacionada 'OrderReceipt'
          create: {
            receiptUrl: paidOrderDto.receiptUrl
          }
        }
      }
    });

    return order;

  }


}
